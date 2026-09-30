import { createHash } from "node:crypto"
import {
  constants,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import { readUpdaterPublicKey, verifyMinisignFile } from "./verify-minisign.mjs"

export const REQUIRED_TARGETS = ["macos-aarch64", "macos-x86_64", "linux-x86_64", "windows-x86_64"]
export const REQUIRED_PLATFORM_KEYS = [
  "darwin-aarch64",
  "darwin-aarch64-app",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "linux-x86_64-rpm",
  "windows-x86_64",
  "windows-x86_64-msi",
  "windows-x86_64-nsis",
]

const DESKTOP_RELEASE_SUFFIXES = [".dmg", ".app.tar.gz", ".deb", ".rpm", ".AppImage", ".msi", "-setup.exe"]
const DESKTOP_ARCHITECTURE_PATTERN = /(?:^|[._-])(?:aarch64|amd64|x64|x86_64)(?:[._-]|$)/i

function asset(source, name, roles, updaterPlatformKeys = []) {
  return { source, name, roles, updaterPlatformKeys }
}

function signature(source, signedFile) {
  return {
    source,
    name: `${signedFile}.sig`,
    roles: ["signature"],
    updaterPlatformKeys: [],
    signedFile,
    trustedFile: basename(source.slice(0, -".sig".length)),
  }
}

export function targetSpec(target, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Release version must be numeric semver: ${version}`)
  const specs = {
    "macos-aarch64": [
      asset(`bundle/dmg/Alook_${version}_aarch64.dmg`, `Alook_${version}_aarch64.dmg`, ["installer"]),
      asset("bundle/macos/Alook.app.tar.gz", `Alook_${version}_aarch64.app.tar.gz`, ["updater"], ["darwin-aarch64", "darwin-aarch64-app"]),
      signature("bundle/macos/Alook.app.tar.gz.sig", `Alook_${version}_aarch64.app.tar.gz`),
    ],
    "macos-x86_64": [
      asset(`bundle/dmg/Alook_${version}_x64.dmg`, `Alook_${version}_x64.dmg`, ["installer"]),
      asset("bundle/macos/Alook.app.tar.gz", `Alook_${version}_x64.app.tar.gz`, ["updater"], ["darwin-x86_64", "darwin-x86_64-app"]),
      signature("bundle/macos/Alook.app.tar.gz.sig", `Alook_${version}_x64.app.tar.gz`),
    ],
    "linux-x86_64": [
      asset(`bundle/deb/Alook_${version}_amd64.deb`, `Alook_${version}_amd64.deb`, ["installer", "updater"], ["linux-x86_64-deb"]),
      signature(`bundle/deb/Alook_${version}_amd64.deb.sig`, `Alook_${version}_amd64.deb`),
      asset(`bundle/rpm/Alook-${version}-1.x86_64.rpm`, `Alook-${version}-1.x86_64.rpm`, ["installer", "updater"], ["linux-x86_64-rpm"]),
      signature(`bundle/rpm/Alook-${version}-1.x86_64.rpm.sig`, `Alook-${version}-1.x86_64.rpm`),
      asset(`bundle/appimage/Alook_${version}_amd64.AppImage`, `Alook_${version}_amd64.AppImage`, ["installer", "updater"], ["linux-x86_64", "linux-x86_64-appimage"]),
      signature(`bundle/appimage/Alook_${version}_amd64.AppImage.sig`, `Alook_${version}_amd64.AppImage`),
    ],
    "windows-x86_64": [
      asset(`bundle/msi/Alook_${version}_x64_en-US.msi`, `Alook_${version}_x64_en-US.msi`, ["installer", "updater"], ["windows-x86_64", "windows-x86_64-msi"]),
      signature(`bundle/msi/Alook_${version}_x64_en-US.msi.sig`, `Alook_${version}_x64_en-US.msi`),
      asset(`bundle/nsis/Alook_${version}_x64-setup.exe`, `Alook_${version}_x64-setup.exe`, ["installer", "updater"], ["windows-x86_64-nsis"]),
      signature(`bundle/nsis/Alook_${version}_x64-setup.exe.sig`, `Alook_${version}_x64-setup.exe`),
    ],
  }
  const spec = specs[target]
  if (!spec) throw new Error(`Unsupported desktop release target: ${target}`)
  return spec
}

async function sha256(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

function assertRegularFile(path, label = path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
  return stat
}

function safeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) return false
  return !path.startsWith("/") && !path.split("/").some((part) => part === "" || part === "." || part === "..")
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

export function resolveSourcePath(sourceRoot, candidate) {
  const sourcePath = resolve(sourceRoot, candidate)
  const sourceRelativePath = relative(sourceRoot, sourcePath)
  if (sourceRelativePath.startsWith(`..${sep}`) || sourceRelativePath === "..") {
    throw new Error(`Source path escapes the bundle root: ${candidate}`)
  }
  return sourcePath
}

export async function collectTarget({ target, version, sourceRoot, stageDirectory }) {
  const source = resolve(sourceRoot)
  const stage = resolve(stageDirectory)
  mkdirSync(stage)
  const filesDirectory = join(stage, "files")
  mkdirSync(filesDirectory)

  const files = []
  for (const expected of targetSpec(target, version).toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (basename(expected.name) !== expected.name) throw new Error(`Unsafe release asset name: ${expected.name}`)
    const sourcePath = resolveSourcePath(source, expected.source)
    assertRegularFile(sourcePath, expected.source)
    const destination = join(filesDirectory, expected.name)
    copyFileSync(sourcePath, destination, constants.COPYFILE_EXCL)
    const stat = assertRegularFile(destination)
    files.push({
      name: expected.name,
      path: `files/${expected.name}`,
      roles: expected.roles,
      updaterPlatformKeys: expected.updaterPlatformKeys,
      ...(expected.signedFile ? { signedFile: expected.signedFile } : {}),
      ...(expected.trustedFile ? { trustedFile: expected.trustedFile } : {}),
      size: stat.size,
      sha256: await sha256(destination),
    })
  }

  const manifest = { schemaVersion: 1, target, version, files }
  writeFileSync(join(stage, "manifest.json"), stableJson(manifest), { flag: "wx" })
  return manifest
}

function assertStringArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} does not match the release contract`)
  }
}

export async function validateStage(stageDirectory, expectedTarget, expectedVersion) {
  const stage = resolve(stageDirectory)
  const stageEntries = readdirSync(stage, { withFileTypes: true })
  if (stageEntries.length !== 2 || !stageEntries.some((entry) => entry.isDirectory() && entry.name === "files") || !stageEntries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
    throw new Error(`${expectedTarget} stage must contain only files/ and manifest.json`)
  }

  const manifestPath = join(stage, "manifest.json")
  assertRegularFile(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (manifest.schemaVersion !== 1 || manifest.target !== expectedTarget || manifest.version !== expectedVersion) {
    throw new Error(`${expectedTarget} manifest identity or version drift`)
  }

  const expectedFiles = targetSpec(expectedTarget, expectedVersion).toSorted((left, right) => left.name.localeCompare(right.name))
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedFiles.length) {
    throw new Error(`${expectedTarget} manifest has an incomplete or extra file set`)
  }

  const actualDirectoryEntries = readdirSync(join(stage, "files"), { withFileTypes: true })
  if (actualDirectoryEntries.length !== expectedFiles.length || actualDirectoryEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error(`${expectedTarget} files directory contains an unexpected entry`)
  }

  const actualFiles = [...manifest.files].toSorted((left, right) => String(left.name).localeCompare(String(right.name)))
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const expected = expectedFiles[index]
    const actual = actualFiles[index]
    if (actual.name !== expected.name || actual.path !== `files/${expected.name}` || !safeRelativePath(actual.path)) {
      throw new Error(`${expectedTarget} manifest contains an unsafe or unexpected asset path`)
    }
    assertStringArray(actual.roles, expected.roles, `${actual.name} roles`)
    assertStringArray(actual.updaterPlatformKeys, expected.updaterPlatformKeys, `${actual.name} updater keys`)
    if ((actual.signedFile ?? null) !== (expected.signedFile ?? null)) throw new Error(`${actual.name} signature association drift`)
    if ((actual.trustedFile ?? null) !== (expected.trustedFile ?? null)) throw new Error(`${actual.name} trusted filename drift`)
    if (!Number.isSafeInteger(actual.size) || actual.size < 0 || !/^[0-9a-f]{64}$/.test(actual.sha256)) {
      throw new Error(`${actual.name} has invalid digest metadata`)
    }

    const filePath = join(stage, actual.path)
    const stat = assertRegularFile(filePath)
    if (stat.size !== actual.size || (await sha256(filePath)) !== actual.sha256) {
      throw new Error(`${actual.name} staged bytes do not match the manifest`)
    }
  }

  return { ...manifest, files: actualFiles }
}

export async function aggregateStages({ stageRoot, outputDirectory, version, repository, pubDate, configPath }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`)
  const date = new Date(pubDate)
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== pubDate) throw new Error(`pubDate must be a canonical ISO timestamp: ${pubDate}`)

  const root = resolve(stageRoot)
  const rootEntries = readdirSync(root, { withFileTypes: true })
  const expectedDirectories = REQUIRED_TARGETS.map((target) => `desktop-release-${target}`).toSorted()
  const actualDirectories = rootEntries.map((entry) => entry.name).toSorted()
  if (rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()) || JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)) {
    throw new Error("Downloaded release stages do not match the four required targets")
  }

  const publicKey = readUpdaterPublicKey(configPath)
  const manifests = []
  for (const target of REQUIRED_TARGETS) {
    manifests.push(await validateStage(join(root, `desktop-release-${target}`), target, version))
  }

  const names = new Set()
  const platformKeys = new Map()
  const assets = []
  for (const manifest of manifests) {
    const stage = join(root, `desktop-release-${manifest.target}`)
    const byName = new Map(manifest.files.map((file) => [file.name, file]))
    for (const file of manifest.files) {
      if (names.has(file.name)) throw new Error(`Duplicate release asset name: ${file.name}`)
      names.add(file.name)
      const path = join(stage, file.path)
      assets.push({ name: file.name, sha256: file.sha256, size: file.size, sourcePath: path, target: manifest.target })

      if (file.signedFile) {
        const signed = byName.get(file.signedFile)
        if (!signed) throw new Error(`${file.name} refers to a missing signed file`)
        await verifyMinisignFile({
          filePath: join(stage, signed.path),
          signaturePath: path,
          encodedPublicKey: publicKey,
          expectedVersion: version,
          expectedTrustedFile: file.trustedFile,
        })
      }
    }

    for (const file of manifest.files.filter((candidate) => candidate.updaterPlatformKeys.length > 0)) {
      const signature = byName.get(`${file.name}.sig`)
      if (!signature || signature.signedFile !== file.name) throw new Error(`${file.name} is missing its adjacent updater signature`)
      const signatureText = readFileSync(join(stage, signature.path), "utf8")
      for (const key of file.updaterPlatformKeys) {
        if (platformKeys.has(key)) throw new Error(`Duplicate updater platform key: ${key}`)
        platformKeys.set(key, {
          signature: signatureText,
          url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(file.name)}`,
        })
      }
    }
  }

  const actualKeys = [...platformKeys.keys()].toSorted()
  assertCompletePlatformKeys(actualKeys)

  const output = resolve(outputDirectory)
  mkdirSync(output)
  const assetsDirectory = join(output, "assets")
  mkdirSync(assetsDirectory)
  const releaseAssets = []
  for (const asset of assets.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const destination = join(assetsDirectory, asset.name)
    copyFileSync(asset.sourcePath, destination, constants.COPYFILE_EXCL)
    if ((await sha256(destination)) !== asset.sha256) throw new Error(`Copied release asset digest drift: ${asset.name}`)
    releaseAssets.push({ name: asset.name, sha256: asset.sha256, size: asset.size, target: asset.target })
  }

  const platforms = Object.fromEntries([...platformKeys.entries()].toSorted(([left], [right]) => left.localeCompare(right)))
  const latest = {
    version,
    notes: `See https://github.com/${repository}/releases/tag/v${version}`,
    pub_date: pubDate,
    platforms,
  }
  const releaseManifest = { schemaVersion: 1, version, assets: releaseAssets }
  writeFileSync(join(output, "latest.json"), stableJson(latest), { flag: "wx" })
  writeFileSync(join(output, "release-manifest.json"), stableJson(releaseManifest), { flag: "wx" })
  return { latest, releaseManifest }
}

function readRelease(releaseJsonPath, expectedTag) {
  if (typeof expectedTag !== "string" || !/^v\d+\.\d+\.\d+$/.test(expectedTag)) {
    throw new Error(`Expected release tag must be numeric semver: ${String(expectedTag)}`)
  }
  const release = JSON.parse(readFileSync(releaseJsonPath, "utf8"))
  if (release.tag_name !== expectedTag) {
    throw new Error(`Release tag mismatch: expected ${expectedTag}, got ${String(release.tag_name)}`)
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error(`Release ${expectedTag} must be a published non-prerelease`)
  }
  if (!Array.isArray(release.assets)) throw new Error("Release API response has no assets array")
  const remote = new Map()
  for (const asset of release.assets) {
    if (typeof asset?.name !== "string") {
      throw new Error("Release API response contains invalid asset metadata")
    }
    if (remote.has(asset.name)) throw new Error(`Remote release contains duplicate asset name: ${asset.name}`)
    remote.set(asset.name, asset.digest)
  }
  return remote
}

function isDesktopReleaseAsset(name) {
  if (name === "latest.json") return true
  const binaryName = name.endsWith(".sig") ? name.slice(0, -".sig".length) : name
  return DESKTOP_RELEASE_SUFFIXES.some((suffix) => binaryName.endsWith(suffix)) && DESKTOP_ARCHITECTURE_PATTERN.test(binaryName)
}

export function assertPublishableRelease({ releaseJsonPath, expectedTag }) {
  const remote = readRelease(releaseJsonPath, expectedTag)
  const existingDesktopAssets = [...remote.keys()].filter(isDesktopReleaseAsset).toSorted()
  if (existingDesktopAssets.length > 0) {
    throw new Error(`Desktop release namespace is immutable and must start empty: ${existingDesktopAssets.join(", ")}`)
  }
}

export function verifyPublishedAssets({ releaseManifestPath, releaseJsonPath, includeLatestPath, expectedTag }) {
  const manifest = JSON.parse(readFileSync(releaseManifestPath, "utf8"))
  if (manifest.schemaVersion !== 1 || manifest.version !== expectedTag.slice(1) || !Array.isArray(manifest.assets)) {
    throw new Error("Published release manifest identity or version drift")
  }
  const remote = readRelease(releaseJsonPath, expectedTag)
  const expected = [...manifest.assets]
  if (includeLatestPath) {
    const latestStat = assertRegularFile(includeLatestPath)
    expected.push({ name: "latest.json", size: latestStat.size, sha256: createHash("sha256").update(readFileSync(includeLatestPath)).digest("hex") })
  }
  const expectedNames = new Set(expected.map((asset) => asset.name))
  const unexpectedDesktopAssets = [...remote.keys()]
    .filter((name) => isDesktopReleaseAsset(name) && !expectedNames.has(name))
    .toSorted()
  if (unexpectedDesktopAssets.length > 0) {
    throw new Error(`Remote release contains unexpected desktop asset candidates: ${unexpectedDesktopAssets.join(", ")}`)
  }
  for (const asset of expected) {
    if (remote.get(asset.name) !== `sha256:${asset.sha256}`) throw new Error(`Remote digest mismatch or missing asset: ${asset.name}`)
  }
}

export function assertCompletePlatformKeys(actualKeys) {
  if (JSON.stringify(actualKeys) !== JSON.stringify(REQUIRED_PLATFORM_KEYS)) {
    throw new Error(`Updater platform set is incomplete: ${actualKeys.join(", ")}`)
  }
}

export function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!key?.startsWith("--") || value == null) throw new Error(`Invalid argument: ${key ?? "<missing>"}`)
    args[key.slice(2)] = value
  }
  return args
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.command === "collect") {
    await collectTarget({ target: args.target, version: args.version, sourceRoot: args.source, stageDirectory: args.stage })
  } else if (args.command === "validate") {
    await validateStage(args.stage, args.target, args.version)
  } else if (args.command === "aggregate") {
    await aggregateStages({
      stageRoot: args.root,
      outputDirectory: args.output,
      version: args.version,
      repository: args.repository,
      pubDate: args["pub-date"],
      configPath: args.config,
    })
  } else if (args.command === "verify-published") {
    verifyPublishedAssets({
      releaseManifestPath: args.manifest,
      releaseJsonPath: args.release,
      includeLatestPath: args.latest,
      expectedTag: args.tag,
    })
  } else if (args.command === "assert-publishable") {
    assertPublishableRelease({ releaseJsonPath: args.release, expectedTag: args.tag })
  } else {
    throw new Error("Expected collect, validate, aggregate, assert-publishable, or verify-published command")
  }
}

export async function runIfMain(
  metaUrl,
  argvPath = process.argv[1],
  argv = process.argv.slice(2),
  runtime = process,
) {
  if (!argvPath || pathToFileURL(argvPath).href !== metaUrl) return false
  try {
    await main(argv)
  } catch (error) {
    runtime.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    runtime.exitCode = 1
  }
  return true
}

void runIfMain(import.meta.url)
