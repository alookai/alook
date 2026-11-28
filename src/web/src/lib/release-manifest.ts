import { DOWNLOAD_TARGETS, type DownloadInstaller, type DownloadTargetId } from "./download-platforms"
import { parseStableSemver } from "./github-releases"

export const RELEASE_MANIFEST_KV_KEY = "public:releases:manifest:v1"
export const RELEASE_MANIFEST_MAX_BYTES = 512 * 1024
export const RELEASE_NOTES_MAX_CHARS = 64 * 1024
const RELEASE_SIGNATURE_MAX_CHARS = 8 * 1024
const GITHUB_RELEASE_DOWNLOAD_PREFIX = "/alookai/alook/releases/download/"
const ISO_8601_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const SAFE_ERROR_KINDS = new Set(["AbortError", "TimeoutError", "TypeError", "SyntaxError", "RangeError"])

interface DesktopUpdaterPlatformSpec {
  suffix: string
  architecture: RegExp
}

const DESKTOP_UPDATER_PLATFORM_MAP = {
  "darwin-aarch64-app": {
    suffix: ".app.tar.gz",
    architecture: /(?:^|[._-])aarch64(?:[._-]|$)/i,
  },
  "darwin-x86_64-app": {
    suffix: ".app.tar.gz",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-appimage": {
    suffix: ".AppImage",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-deb": {
    suffix: ".deb",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-x86_64-rpm": {
    suffix: ".rpm",
    architecture: /(?:^|[._-])(?:amd64|x64|x86_64)(?:[._-]|$)/i,
  },
  "linux-aarch64-appimage": {
    suffix: ".AppImage",
    architecture: /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i,
  },
  "linux-aarch64-deb": {
    suffix: ".deb",
    architecture: /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i,
  },
  "linux-aarch64-rpm": {
    suffix: ".rpm",
    architecture: /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i,
  },
  "windows-x86_64-msi": {
    suffix: ".msi",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
  "windows-x86_64-nsis": {
    suffix: "-setup.exe",
    architecture: /(?:^|[._-])(?:x64|x86_64)(?:[._-]|$)/i,
  },
  "windows-aarch64-msi": {
    suffix: ".msi",
    architecture: /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i,
  },
  "windows-aarch64-nsis": {
    suffix: "-setup.exe",
    architecture: /(?:^|[._-])(?:aarch64|arm64)(?:[._-]|$)/i,
  },
} as const satisfies Record<string, DesktopUpdaterPlatformSpec>

export type DesktopUpdaterPlatformKey = keyof typeof DESKTOP_UPDATER_PLATFORM_MAP

interface DesktopUpdaterPlatformEntry {
  url: string
  signature: string
}

interface DesktopUpdaterManifest {
  version: string
  notes: string
  pub_date: string | null
  platforms: Partial<Record<DesktopUpdaterPlatformKey, DesktopUpdaterPlatformEntry>>
}

export interface ReleaseManifest {
  schemaVersion: 1
  syncedAt: string
  installers: DownloadInstaller[]
  desktopUpdater: DesktopUpdaterManifest | null
}

export type ReleaseManifestValidationResult =
  | { ok: true; manifest: ReleaseManifest }
  | { ok: false; error: string }

export type ReleaseManifestKvReadResult =
  | { status: "ok"; manifest: ReleaseManifest }
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "error"; errorKind: string }

const DOWNLOAD_TARGET_BY_ID = new Map(DOWNLOAD_TARGETS.map((target) => [target.id, target]))

export function isDesktopUpdaterPlatformKey(value: string): value is DesktopUpdaterPlatformKey {
  return Object.prototype.hasOwnProperty.call(DESKTOP_UPDATER_PLATFORM_MAP, value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_8601_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value))
}

function parseGitHubReleaseDownloadUrl(rawUrl: unknown, expectedVersion: string): { href: string; assetName: string } | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (
    parsed.origin !== "https://github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null
  }
  const tag = `v${expectedVersion}`
  const expectedPrefix = `${GITHUB_RELEASE_DOWNLOAD_PREFIX}${encodeURIComponent(tag)}/`
  if (!parsed.pathname.startsWith(expectedPrefix)) return null
  const encodedAssetName = parsed.pathname.slice(expectedPrefix.length)
  if (!encodedAssetName || encodedAssetName.includes("/")) return null
  let assetName: string
  try {
    assetName = decodeURIComponent(encodedAssetName)
  } catch {
    return null
  }
  if (!assetName || assetName.includes("/") || assetName === "." || assetName === "..") return null
  if (parsed.pathname !== `${expectedPrefix}${encodeURIComponent(assetName)}`) return null
  return { href: parsed.href, assetName }
}

function matchesInstallerAssetName(targetId: DownloadTargetId, version: string, assetName: string): boolean {
  const target = DOWNLOAD_TARGET_BY_ID.get(targetId)
  if (!target) return false
  if (targetId === "linux-rpm") {
    const prefix = `Alook-${version}-`
    return assetName.startsWith(prefix) && /^\d+\.x86_64\.rpm$/.test(assetName.slice(prefix.length))
  }
  return assetName === `Alook_${version}${target.suffix}`
}

function matchesUpdaterAssetName(platformKey: DesktopUpdaterPlatformKey, assetName: string): boolean {
  const spec = DESKTOP_UPDATER_PLATFORM_MAP[platformKey]
  return !assetName.endsWith(".sig") && assetName.endsWith(spec.suffix) && spec.architecture.test(assetName)
}

function validateInstallerEntry(entry: unknown, seenIds: Set<DownloadTargetId>): { ok: true; installer: DownloadInstaller } | { ok: false; error: string } {
  if (!isPlainRecord(entry)) return { ok: false, error: "Installer entry must be an object" }
  const { id, version, url, bytes } = entry
  if (typeof id !== "string" || !DOWNLOAD_TARGET_BY_ID.has(id as DownloadTargetId)) {
    return { ok: false, error: "Installer entry has unsupported target id" }
  }
  const targetId = id as DownloadTargetId
  if (seenIds.has(targetId)) {
    return { ok: false, error: `Duplicate installer id: ${targetId}` }
  }
  if (typeof version !== "string" || !parseStableSemver(version)) {
    return { ok: false, error: `Installer ${targetId} has invalid version` }
  }
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    return { ok: false, error: `Installer ${targetId} has invalid byte size` }
  }
  const parsedUrl = parseGitHubReleaseDownloadUrl(url, version)
  if (!parsedUrl || !matchesInstallerAssetName(targetId, version, parsedUrl.assetName)) {
    return { ok: false, error: `Installer ${targetId} has invalid release download URL` }
  }
  seenIds.add(targetId)
  return {
    ok: true,
    installer: {
      id: targetId,
      version,
      url: parsedUrl.href,
      bytes,
    },
  }
}

function validateDesktopUpdater(value: unknown): { ok: true; desktopUpdater: DesktopUpdaterManifest | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, desktopUpdater: null }
  if (!isPlainRecord(value)) return { ok: false, error: "desktopUpdater must be an object or null" }

  const { version, notes, pub_date, platforms } = value
  if (typeof version !== "string" || !parseStableSemver(version)) {
    return { ok: false, error: "desktopUpdater.version must be a stable semver string" }
  }
  if (typeof notes !== "string" || notes.length > RELEASE_NOTES_MAX_CHARS) {
    return { ok: false, error: "desktopUpdater.notes must be a string within length limit" }
  }
  if (pub_date !== null && !isIsoTimestamp(pub_date)) {
    return { ok: false, error: "desktopUpdater.pub_date must be null or an ISO-8601 timestamp" }
  }
  if (!isPlainRecord(platforms)) {
    return { ok: false, error: "desktopUpdater.platforms must be an object" }
  }
  const platformKeys = Object.keys(platforms)
  if (platformKeys.length === 0) {
    return { ok: false, error: "desktopUpdater.platforms must include at least one platform" }
  }

  const normalizedPlatforms: Partial<Record<DesktopUpdaterPlatformKey, DesktopUpdaterPlatformEntry>> = {}
  for (const key of platformKeys) {
    if (!isDesktopUpdaterPlatformKey(key)) {
      return { ok: false, error: `Unsupported desktopUpdater platform key: ${key}` }
    }
    const entry = platforms[key]
    if (!isPlainRecord(entry)) {
      return { ok: false, error: `desktopUpdater.platforms.${key} must be an object` }
    }
    const parsedUrl = parseGitHubReleaseDownloadUrl(entry.url, version)
    if (!parsedUrl || !matchesUpdaterAssetName(key, parsedUrl.assetName)) {
      return { ok: false, error: `desktopUpdater.platforms.${key}.url is invalid` }
    }
    if (typeof entry.signature !== "string") {
      return { ok: false, error: `desktopUpdater.platforms.${key}.signature must be a string` }
    }
    const signature = entry.signature.trim()
    if (!signature || signature.length > RELEASE_SIGNATURE_MAX_CHARS) {
      return { ok: false, error: `desktopUpdater.platforms.${key}.signature must be non-empty and bounded` }
    }
    normalizedPlatforms[key] = {
      url: parsedUrl.href,
      signature,
    }
  }

  return {
    ok: true,
    desktopUpdater: {
      version,
      notes,
      pub_date,
      platforms: normalizedPlatforms,
    },
  }
}

export function validateReleaseManifest(input: unknown): ReleaseManifestValidationResult {
  if (!isPlainRecord(input)) {
    return { ok: false, error: "Manifest must be a JSON object" }
  }
  if (input.schemaVersion !== 1) {
    return { ok: false, error: "Unsupported manifest schemaVersion" }
  }
  if (!isIsoTimestamp(input.syncedAt)) {
    return { ok: false, error: "Manifest syncedAt must be an ISO-8601 timestamp" }
  }
  if (!Array.isArray(input.installers) || input.installers.length > DOWNLOAD_TARGETS.length) {
    return { ok: false, error: "Manifest installers must be a valid array" }
  }

  const seenIds = new Set<DownloadTargetId>()
  const installers: DownloadInstaller[] = []
  for (const entry of input.installers) {
    const validated = validateInstallerEntry(entry, seenIds)
    if (!validated.ok) return validated
    installers.push(validated.installer)
  }

  const desktopUpdaterResult = validateDesktopUpdater(input.desktopUpdater)
  if (!desktopUpdaterResult.ok) return desktopUpdaterResult

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      syncedAt: input.syncedAt,
      installers,
      desktopUpdater: desktopUpdaterResult.desktopUpdater,
    },
  }
}

function safeErrorKind(error: unknown): string {
  try {
    if (error instanceof Error && SAFE_ERROR_KINDS.has(error.name)) {
      return error.name
    }
  } catch {
    return "Error"
  }
  return "Error"
}

export async function readReleaseManifestFromKv(kv: KVNamespace): Promise<ReleaseManifestKvReadResult> {
  let raw: string | null
  try {
    raw = await kv.get(RELEASE_MANIFEST_KV_KEY, "text")
  } catch (error) {
    return { status: "error", errorKind: safeErrorKind(error) }
  }
  if (raw === null) {
    return { status: "missing" }
  }
  if (new TextEncoder().encode(raw).byteLength > RELEASE_MANIFEST_MAX_BYTES) {
    return { status: "corrupt", reason: "payload_too_large" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "corrupt", reason: "invalid_json" }
  }
  const validated = validateReleaseManifest(parsed)
  if (!validated.ok) {
    return { status: "corrupt", reason: "invalid_schema" }
  }
  return { status: "ok", manifest: validated.manifest }
}
