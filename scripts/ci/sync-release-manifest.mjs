import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const DEFAULT_REPOSITORY = "alookai/alook"
export const DEFAULT_SYNC_ENDPOINT = "https://alook.ai/api/releases/sync"
export const DEFAULT_OIDC_AUDIENCE = "https://alook.ai"
export const RELEASE_NOTES_MAX_CHARS = 64 * 1024
const RELEASES_PER_PAGE = 100
const FETCH_TIMEOUT_MS = 20_000
const SYNC_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 7000]

export const DOWNLOAD_TARGETS = [
  { id: "mac-arm", platform: "macos", suffix: "_aarch64.dmg" },
  { id: "mac-intel", platform: "macos", suffix: "_x64.dmg" },
  { id: "windows-exe", platform: "windows", suffix: "_x64-setup.exe" },
  { id: "windows-msi", platform: "windows", suffix: "_x64_en-US.msi" },
  { id: "linux-deb", platform: "linux", suffix: "_amd64.deb" },
  { id: "linux-rpm", platform: "linux", suffix: ".x86_64.rpm" },
  { id: "linux-appimage", platform: "linux", suffix: "_amd64.AppImage" },
  { id: "android-apk", platform: "android", suffix: "_android.apk" },
]

export const DESKTOP_UPDATER_PLATFORM_SPECS = {
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
}

export function parseStableSemver(version) {
  if (typeof version !== "string") return null
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599)
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function fetchWithRetry(
  url,
  init,
  { fetchFn = fetch, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleepFn = defaultSleep, timeoutMs = FETCH_TIMEOUT_MS } = {},
) {
  let lastError
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      const response = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.ok || !isRetryableStatus(response.status) || attempt === retryDelaysMs.length) {
        return response
      }
      lastError = new Error(`HTTP ${response.status} from ${url}`)
    } catch (error) {
      lastError = error
      if (attempt === retryDelaysMs.length) throw error
    }
    await sleepFn(retryDelaysMs[attempt])
  }
  throw lastError
}

function releaseAssetUrl(asset, tag, repo) {
  if (!asset || typeof asset !== "object") return null
  if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") return null
  if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) return null
  if (asset.state !== undefined && asset.state !== "uploaded") return null
  try {
    const url = new URL(asset.browser_download_url)
    const expectedPath = `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`
    return url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === expectedPath
      ? url.href
      : null
  } catch {
    return null
  }
}

function isValidRelease(release) {
  return Boolean(
    release &&
    typeof release === "object" &&
    typeof release.tag_name === "string" &&
    typeof release.draft === "boolean" &&
    typeof release.prerelease === "boolean" &&
    Array.isArray(release.assets),
  )
}

function hasValidDesktopCompletionMarker(release, repo) {
  return release.assets.some((asset) => asset?.name === "latest.json" && Boolean(releaseAssetUrl(asset, release.tag_name, repo)))
}

function findDesktopUpdaterAssets(release, repo) {
  const matched = []
  for (const [platformKey, spec] of Object.entries(DESKTOP_UPDATER_PLATFORM_SPECS)) {
    const binary = release.assets.find(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        !asset.name.endsWith(".sig") &&
        asset.name.endsWith(spec.suffix) &&
        spec.architecture.test(asset.name) &&
        Boolean(releaseAssetUrl(asset, release.tag_name, repo)),
    )
    if (!binary) continue
    const signature = release.assets.find(
      (asset) =>
        asset &&
        asset.name === `${binary.name}.sig` &&
        Boolean(releaseAssetUrl(asset, release.tag_name, repo)),
    )
    if (!signature) continue
    const binaryUrl = releaseAssetUrl(binary, release.tag_name, repo)
    const signatureUrl = releaseAssetUrl(signature, release.tag_name, repo)
    if (binaryUrl && signatureUrl) {
      matched.push({ platformKey, binaryUrl, signatureUrl })
    }
  }
  return matched
}

export async function fetchGitHubReleases({
  repo = DEFAULT_REPOSITORY,
  ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
  fetchFn = fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepFn = defaultSleep,
} = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "alook-release-manifest-sync",
  }
  if (ghToken) {
    headers.Authorization = `Bearer ${ghToken}`
  }
  const url = `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`
  const response = await fetchWithRetry(url, { headers }, { fetchFn, retryDelaysMs, sleepFn })
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with HTTP ${response.status}`)
  }
  const data = await response.json()
  if (!Array.isArray(data)) {
    throw new Error("GitHub releases response must be an array")
  }
  return data
}

export async function fetchSignatureText(
  signatureUrl,
  { fetchFn = fetch, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleepFn = defaultSleep } = {},
) {
  const response = await fetchWithRetry(
    signatureUrl,
    { headers: { Accept: "text/plain, */*", "User-Agent": "alook-release-manifest-sync" } },
    { fetchFn, retryDelaysMs, sleepFn },
  )
  if (!response.ok) {
    throw new Error(`Signature download failed for ${signatureUrl} with HTTP ${response.status}`)
  }
  const signature = (await response.text()).trim()
  if (!signature) {
    throw new Error(`Signature file is empty for ${signatureUrl}`)
  }
  return signature
}

export async function buildReleaseManifest(
  releasesInput,
  {
    repo = DEFAULT_REPOSITORY,
    syncedAt = new Date().toISOString(),
    fetchSignature = fetchSignatureText,
  } = {},
) {
  if (!Array.isArray(releasesInput) || !releasesInput.every(isValidRelease)) {
    throw new Error("Invalid GitHub releases payload")
  }

  const stableReleases = releasesInput
    .filter((release) => !release.draft && !release.prerelease && release.tag_name.startsWith("v"))
    .flatMap((release) => {
      const versionText = release.tag_name.slice(1)
      const semver = parseStableSemver(versionText)
      return semver ? [{ release, versionText, semver }] : []
    })
    .sort((a, b) => compareVersions(b.semver, a.semver))

  const installers = DOWNLOAD_TARGETS.flatMap((target) => {
    for (const { release, versionText } of stableReleases) {
      if (target.platform !== "android" && !hasValidDesktopCompletionMarker(release, repo)) {
        continue
      }
      const asset = release.assets.find((item) => {
        if (!item || typeof item.name !== "string") return false
        if (target.id === "linux-rpm") {
          const prefix = `Alook-${versionText}-`
          return item.name.startsWith(prefix) && /^\d+\.x86_64\.rpm$/.test(item.name.slice(prefix.length))
        }
        return item.name === `Alook_${versionText}${target.suffix}`
      })
      const url = asset ? releaseAssetUrl(asset, release.tag_name, repo) : null
      if (url && asset) {
        return [{ id: target.id, version: versionText, url, bytes: asset.size }]
      }
    }
    return []
  })

  let desktopUpdater = null
  for (const { release, versionText } of stableReleases) {
    if (!hasValidDesktopCompletionMarker(release, repo)) continue
    const platformMatches = findDesktopUpdaterAssets(release, repo)
    if (platformMatches.length === 0) continue

    const platforms = {}
    for (const match of platformMatches) {
      const signature = (await fetchSignature(match.signatureUrl)).trim()
      if (!signature) {
        throw new Error(`Empty signature for ${match.platformKey} (${match.signatureUrl})`)
      }
      platforms[match.platformKey] = {
        url: match.binaryUrl,
        signature,
      }
    }

    const rawNotes = typeof release.body === "string" ? release.body : ""
    const notes = rawNotes.length > RELEASE_NOTES_MAX_CHARS
      ? rawNotes.slice(0, RELEASE_NOTES_MAX_CHARS)
      : rawNotes
    const pubDate = typeof release.published_at === "string" && !Number.isNaN(Date.parse(release.published_at))
      ? release.published_at
      : null

    desktopUpdater = {
      version: versionText,
      notes,
      pub_date: pubDate,
      platforms,
    }
    break
  }

  return {
    schemaVersion: 1,
    syncedAt,
    installers,
    desktopUpdater,
  }
}

export async function requestOidcToken({
  requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
  requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  audience = DEFAULT_OIDC_AUDIENCE,
  fetchFn = fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepFn = defaultSleep,
} = {}) {
  if (!requestUrl || !requestToken) {
    throw new Error("Missing ACTIONS_ID_TOKEN_REQUEST_URL or ACTIONS_ID_TOKEN_REQUEST_TOKEN")
  }
  const url = new URL(requestUrl)
  url.searchParams.set("audience", audience)
  const response = await fetchWithRetry(
    url.href,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requestToken}`,
        Accept: "application/json",
      },
    },
    { fetchFn, retryDelaysMs, sleepFn },
  )
  if (!response.ok) {
    throw new Error(`OIDC token request failed with HTTP ${response.status}`)
  }
  const body = await response.json()
  if (!body || typeof body.value !== "string" || !body.value.trim()) {
    throw new Error("OIDC token response did not contain a valid token value")
  }
  return body.value.trim()
}

export async function pushReleaseManifest({
  endpoint = DEFAULT_SYNC_ENDPOINT,
  token,
  manifest,
  fetchFn = fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleepFn = defaultSleep,
} = {}) {
  if (!token) {
    throw new Error("Missing OIDC bearer token for manifest sync")
  }
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(manifest),
    },
    { fetchFn, retryDelaysMs, sleepFn, timeoutMs: SYNC_TIMEOUT_MS },
  )
  const responseText = await response.text()
  if (!response.ok) {
    throw new Error(`Manifest sync failed with HTTP ${response.status}: ${responseText.slice(0, 500)}`)
  }
  return responseText ? JSON.parse(responseText) : { ok: true }
}

export function parseCliArgs(argv) {
  const options = {
    dryRun: false,
    out: null,
    endpoint: process.env.RELEASE_SYNC_ENDPOINT || DEFAULT_SYNC_ENDPOINT,
    audience: process.env.RELEASE_SYNC_AUDIENCE || DEFAULT_OIDC_AUDIENCE,
    repo: process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--dry-run") {
      options.dryRun = true
    } else if (arg === "--out") {
      options.out = argv[++i]
      if (!options.out) throw new Error("--out requires a file path")
    } else if (arg === "--endpoint") {
      options.endpoint = argv[++i]
      if (!options.endpoint) throw new Error("--endpoint requires a URL")
    } else if (arg === "--audience") {
      options.audience = argv[++i]
      if (!options.audience) throw new Error("--audience requires a value")
    } else if (arg === "--repo") {
      options.repo = argv[++i]
      if (!options.repo) throw new Error("--repo requires owner/name")
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv)
  const releases = await fetchGitHubReleases({ repo: options.repo })
  const manifest = await buildReleaseManifest(releases, { repo: options.repo })

  if (options.out) {
    const targetPath = resolve(options.out)
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  }

  const summary = {
    dryRun: options.dryRun,
    repo: options.repo,
    syncedAt: manifest.syncedAt,
    installerCount: manifest.installers.length,
    installerVersions: Object.fromEntries(manifest.installers.map((item) => [item.id, item.version])),
    desktopVersion: manifest.desktopUpdater?.version ?? null,
    desktopPlatformCount: manifest.desktopUpdater ? Object.keys(manifest.desktopUpdater.platforms).length : 0,
  }

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return summary
  }

  const token = await requestOidcToken({ audience: options.audience })
  const result = await pushReleaseManifest({
    endpoint: options.endpoint,
    token,
    manifest,
  })
  process.stdout.write(`${JSON.stringify({ ...summary, result }, null, 2)}\n`)
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
