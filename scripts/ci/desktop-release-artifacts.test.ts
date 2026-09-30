import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import {
  REQUIRED_PLATFORM_KEYS,
  REQUIRED_TARGETS,
  aggregateStages,
  assertCompletePlatformKeys,
  assertPublishableRelease,
  collectTarget,
  main as runDesktopReleaseCli,
  parseArgs as parseDesktopReleaseArgs,
  resolveSourcePath,
  runIfMain as runDesktopReleaseIfMain,
  targetSpec,
  validateStage,
  verifyPublishedAssets,
} from "./desktop-release-artifacts.mjs"

const version = "1.2.3"
const temporaryDirectories: string[] = []

function createSigningFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicDer = publicKey.export({ format: "der", type: "spki" })
  const keyId = randomBytes(8)
  const publicPacket = Buffer.concat([Buffer.from("ED"), keyId, publicDer.subarray(-32)])
  const publicFile = `untrusted comment: fixture key\n${publicPacket.toString("base64")}\n`
  return {
    encodedPublicKey: Buffer.from(publicFile).toString("base64"),
    sign(data: Buffer, name: string) {
      const digest = createHash("blake2b512").update(data).digest()
      const fileSignature = sign(null, digest, privateKey)
      const trustedComment = `timestamp:1\tfile:${name}\tversion:${version}`
      const globalSignature = sign(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), privateKey)
      const packet = Buffer.concat([Buffer.from("ED"), keyId, fileSignature])
      const signatureBox = `untrusted comment: fixture signature\n${packet.toString("base64")}\ntrusted comment: ${trustedComment}\n${globalSignature.toString("base64")}\n`
      return Buffer.from(signatureBox).toString("base64")
    },
  }
}

async function createAllStages() {
  const directory = mkdtempSync(join(tmpdir(), "alook-release-artifacts-"))
  temporaryDirectories.push(directory)
  const stages = join(directory, "stages")
  mkdirSync(stages)
  const signer = createSigningFixture()
  const configPath = join(directory, "tauri.conf.json")
  writeFileSync(configPath, JSON.stringify({ plugins: { updater: { pubkey: signer.encodedPublicKey } } }))

  for (const target of REQUIRED_TARGETS) {
    const source = join(directory, `source-${target}`)
    mkdirSync(source)
    const contents = new Map<string, Buffer>()
    for (const expected of targetSpec(target, version)) {
      const path = join(source, expected.source)
      mkdirSync(dirname(path), { recursive: true })
      if (expected.signedFile) {
        const signedContents = contents.get(expected.signedFile)
        if (!signedContents) throw new Error(`Fixture signature appears before signed file: ${expected.signedFile}`)
        writeFileSync(path, signer.sign(signedContents, expected.trustedFile))
      } else {
        const data = Buffer.from(`${target}:${expected.name}`)
        contents.set(expected.name, data)
        writeFileSync(path, data)
      }
    }
    await collectTarget({ target, version, sourceRoot: source, stageDirectory: join(stages, `desktop-release-${target}`) })
  }
  return { directory, stages, configPath }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

describe("desktop release artifact staging", () => {
  it("rejects unsupported target metadata and source path escapes", () => {
    expect(() => targetSpec("linux-x86_64", "v1.2.3")).toThrow("numeric semver")
    expect(() => targetSpec("freebsd-x86_64", version)).toThrow("Unsupported desktop release target")

    const root = join(tmpdir(), "alook-release-source")
    expect(resolveSourcePath(root, "bundle/app")).toBe(join(root, "bundle/app"))
    expect(() => resolveSourcePath(root, "../escape")).toThrow("escapes the bundle root")

    expect(() => assertCompletePlatformKeys(REQUIRED_PLATFORM_KEYS)).not.toThrow()
    expect(() => assertCompletePlatformKeys(REQUIRED_PLATFORM_KEYS.slice(1))).toThrow("platform set is incomplete")
  })

  it("collects exact allowlisted bytes and records stable digests", async () => {
    const fixture = await createAllStages()
    for (const target of REQUIRED_TARGETS) {
      const manifest = await validateStage(join(fixture.stages, `desktop-release-${target}`), target, version)
      expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
        [...manifest.files.map((file: { name: string }) => file.name)].sort((left, right) => left.localeCompare(right)),
      )
    }
  })

  it("aggregates all eleven updater keys deterministically", async () => {
    const fixture = await createAllStages()
    const firstOutput = join(fixture.directory, "output-a")
    const first = await aggregateStages({
      stageRoot: fixture.stages,
      outputDirectory: firstOutput,
      version,
      repository: "alookai/alook",
      pubDate: "2026-09-29T00:00:00.000Z",
      configPath: fixture.configPath,
    })

    for (const target of REQUIRED_TARGETS) {
      const manifestPath = join(fixture.stages, `desktop-release-${target}`, "manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.files.reverse()
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    const secondOutput = join(fixture.directory, "output-b")
    const second = await aggregateStages({
      stageRoot: fixture.stages,
      outputDirectory: secondOutput,
      version,
      repository: "alookai/alook",
      pubDate: "2026-09-29T00:00:00.000Z",
      configPath: fixture.configPath,
    })

    expect(Object.keys(first.latest.platforms)).toEqual(REQUIRED_PLATFORM_KEYS)
    expect(readFileSync(join(firstOutput, "latest.json"))).toEqual(readFileSync(join(secondOutput, "latest.json")))
    expect(second.releaseManifest).toEqual(first.releaseManifest)
  })

  it.each([
    ["version drift", (manifest: any) => (manifest.version = "9.9.9"), "identity or version drift"],
    ["traversal", (manifest: any) => (manifest.files[0].path = "../escape"), "unsafe or unexpected asset path"],
    ["duplicate asset", (manifest: any) => (manifest.files[1].name = manifest.files[0].name), "unsafe or unexpected asset path"],
    ["platform key drift", (manifest: any) => (manifest.files.find((file: any) => file.updaterPlatformKeys.length).updaterPlatformKeys = ["bad-key"]), "updater keys"],
    ["incomplete file set", (manifest: any) => manifest.files.pop(), "incomplete or extra file set"],
    ["role drift", (manifest: any) => (manifest.files[0].roles = ["wrong"]), "roles"],
    ["signature association drift", (manifest: any) => (manifest.files.find((file: any) => file.signedFile).signedFile = "wrong"), "signature association drift"],
    ["trusted filename drift", (manifest: any) => (manifest.files.find((file: any) => file.trustedFile).trustedFile = "wrong"), "trusted filename drift"],
    ["invalid digest metadata", (manifest: any) => (manifest.files[0].size = -1), "invalid digest metadata"],
  ])("rejects %s in a stage manifest", async (_label, mutate, message) => {
    const fixture = await createAllStages()
    const stage = join(fixture.stages, "desktop-release-windows-x86_64")
    const manifestPath = join(stage, "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    mutate(manifest)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await expect(validateStage(stage, "windows-x86_64", version)).rejects.toThrow(message)
  })

  it("rejects digest drift, extra files, symlinks, and missing targets", async () => {
    const fixture = await createAllStages()
    const stage = join(fixture.stages, "desktop-release-linux-x86_64")
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"))
    writeFileSync(join(stage, manifest.files[0].path), "mutated")
    await expect(validateStage(stage, "linux-x86_64", version)).rejects.toThrow("staged bytes")

    const fresh = await createAllStages()
    const freshStage = join(fresh.stages, "desktop-release-macos-aarch64")
    writeFileSync(join(freshStage, "files", "extra"), "extra")
    await expect(validateStage(freshStage, "macos-aarch64", version)).rejects.toThrow("unexpected entry")

    const invalidShape = await createAllStages()
    const invalidShapeStage = join(invalidShape.stages, "desktop-release-macos-aarch64")
    writeFileSync(join(invalidShapeStage, "unexpected"), "unexpected")
    await expect(validateStage(invalidShapeStage, "macos-aarch64", version)).rejects.toThrow("only files/")

    const symlinkFixture = await createAllStages()
    const symlinkStage = join(symlinkFixture.stages, "desktop-release-macos-x86_64")
    symlinkSync(join(symlinkStage, "manifest.json"), join(symlinkStage, "files", "link"))
    await expect(validateStage(symlinkStage, "macos-x86_64", version)).rejects.toThrow("unexpected entry")

    const missing = await createAllStages()
    rmSync(join(missing.stages, "desktop-release-windows-x86_64"), { recursive: true })
    await expect(
      aggregateStages({
        stageRoot: missing.stages,
        outputDirectory: join(missing.directory, "output"),
        version,
        repository: "alookai/alook",
        pubDate: "2026-09-29T00:00:00.000Z",
        configPath: missing.configPath,
      }),
    ).rejects.toThrow("four required targets")
  })

  it("rejects a wrong minisign signature before producing publish bytes", async () => {
    const fixture = await createAllStages()
    const signature = join(fixture.stages, "desktop-release-windows-x86_64", "files", `Alook_${version}_x64-setup.exe.sig`)
    const signatureBox = Buffer.from(readFileSync(signature, "utf8"), "base64")
      .toString("utf8")
      .replace("timestamp:1", "timestamp:2")
    const contents = Buffer.from(signatureBox).toString("base64")
    writeFileSync(signature, contents)
    const manifestPath = join(fixture.stages, "desktop-release-windows-x86_64", "manifest.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    const entry = manifest.files.find((file: { name: string }) => file.name.endsWith("setup.exe.sig"))
    entry.size = Buffer.byteLength(contents)
    entry.sha256 = createHash("sha256").update(contents).digest("hex")
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await expect(
      aggregateStages({
        stageRoot: fixture.stages,
        outputDirectory: join(fixture.directory, "output"),
        version,
        repository: "alookai/alook",
        pubDate: "2026-09-29T00:00:00.000Z",
        configPath: fixture.configPath,
      }),
    ).rejects.toThrow("trusted-comment")
  })

  it("accepts an empty desktop namespace alongside Android and rejects wrong tags or reruns", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-release-state-"))
    temporaryDirectories.push(directory)
    const releaseJsonPath = join(directory, "release.json")
    const writeRelease = (tag: string, names: string[]) => writeFileSync(
      releaseJsonPath,
      JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets: names.map((name) => ({ name, digest: "sha256:fixture" })) }),
    )

    writeRelease("v1.2.3", ["Alook_1.2.3_universal.apk"])
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).not.toThrow()
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.4" })).toThrow("Release tag mismatch")

    writeRelease("v1.2.3", [`Alook_${version}_x64-setup.exe`, `Alook_${version}_x64-setup.exe.sig`])
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).toThrow("must start empty")
  })

  it("rejects malformed release API and release-manifest state", () => {
    const directory = mkdtempSync(join(tmpdir(), "alook-release-invalid-state-"))
    temporaryDirectories.push(directory)
    const releaseJsonPath = join(directory, "release.json")
    const manifestPath = join(directory, "release-manifest.json")

    writeFileSync(releaseJsonPath, JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false, assets: [] }))
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "1.2.3" })).toThrow("numeric semver")

    writeFileSync(releaseJsonPath, JSON.stringify({ tag_name: "v1.2.3", draft: true, prerelease: false, assets: [] }))
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).toThrow("published non-prerelease")

    writeFileSync(releaseJsonPath, JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false }))
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).toThrow("no assets array")

    writeFileSync(releaseJsonPath, JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false, assets: [{}] }))
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).toThrow("invalid asset metadata")

    writeFileSync(releaseJsonPath, JSON.stringify({
      tag_name: "v1.2.3",
      draft: false,
      prerelease: false,
      assets: [{ name: "duplicate" }, { name: "duplicate" }],
    }))
    expect(() => assertPublishableRelease({ releaseJsonPath, expectedTag: "v1.2.3" })).toThrow("duplicate asset name")

    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 2, version, assets: [] }))
    writeFileSync(releaseJsonPath, JSON.stringify({ tag_name: "v1.2.3", draft: false, prerelease: false, assets: [] }))
    expect(() => verifyPublishedAssets({
      releaseManifestPath: manifestPath,
      releaseJsonPath,
      expectedTag: "v1.2.3",
    })).toThrow("manifest identity or version drift")
  })

  it("compares exact published desktop digests while allowing an Android APK", async () => {
    const fixture = await createAllStages()
    const output = join(fixture.directory, "output")
    const { releaseManifest } = await aggregateStages({
      stageRoot: fixture.stages,
      outputDirectory: output,
      version,
      repository: "alookai/alook",
      pubDate: "2026-09-29T00:00:00.000Z",
      configPath: fixture.configPath,
    })
    const releaseJsonPath = join(fixture.directory, "release.json")
    writeFileSync(
      releaseJsonPath,
      JSON.stringify({
        tag_name: "v1.2.3",
        draft: false,
        prerelease: false,
        assets: [
          ...releaseManifest.assets.map((asset) => ({ name: asset.name, digest: `sha256:${asset.sha256}` })),
          { name: "Alook_1.2.3_universal.apk", digest: "sha256:android" },
        ],
      }),
    )
    expect(() =>
      verifyPublishedAssets({
        releaseManifestPath: join(output, "release-manifest.json"),
        releaseJsonPath,
        expectedTag: "v1.2.3",
      }),
    ).not.toThrow()
    const withLatest = JSON.parse(readFileSync(releaseJsonPath, "utf8"))
    const latestBytes = readFileSync(join(output, "latest.json"))
    withLatest.assets.push({
      name: "latest.json",
      digest: `sha256:${createHash("sha256").update(latestBytes).digest("hex")}`,
    })
    writeFileSync(releaseJsonPath, JSON.stringify(withLatest))
    expect(() => verifyPublishedAssets({
      releaseManifestPath: join(output, "release-manifest.json"),
      releaseJsonPath,
      includeLatestPath: join(output, "latest.json"),
      expectedTag: "v1.2.3",
    })).not.toThrow()
    const remote = JSON.parse(readFileSync(releaseJsonPath, "utf8"))
    remote.assets[0].digest = "sha256:deadbeef"
    writeFileSync(releaseJsonPath, JSON.stringify(remote))
    expect(() =>
      verifyPublishedAssets({
        releaseManifestPath: join(output, "release-manifest.json"),
        releaseJsonPath,
        includeLatestPath: join(output, "latest.json"),
        expectedTag: "v1.2.3",
      }),
    ).toThrow("Remote digest mismatch")
  })

  it("rejects stale desktop candidates after publication", async () => {
    const fixture = await createAllStages()
    const output = join(fixture.directory, "output")
    const { releaseManifest } = await aggregateStages({
      stageRoot: fixture.stages,
      outputDirectory: output,
      version,
      repository: "alookai/alook",
      pubDate: "2026-09-29T00:00:00.000Z",
      configPath: fixture.configPath,
    })
    const releaseJsonPath = join(fixture.directory, "release.json")
    writeFileSync(releaseJsonPath, JSON.stringify({
      tag_name: "v1.2.3",
      draft: false,
      prerelease: false,
      assets: [
        ...releaseManifest.assets.map((asset) => ({ name: asset.name, digest: `sha256:${asset.sha256}` })),
        { name: "other_9.9.9_x64-setup.exe.sig", digest: "sha256:stale" },
      ],
    }))
    expect(() => verifyPublishedAssets({
      releaseManifestPath: join(output, "release-manifest.json"),
      releaseJsonPath,
      expectedTag: "v1.2.3",
    })).toThrow("unexpected desktop asset candidates")
  })

  it("covers every CLI dispatch and fail-closed entrypoint handling", async () => {
    expect(parseDesktopReleaseArgs(["aggregate", "--root", "stages"])).toEqual({ command: "aggregate", root: "stages" })
    expect(() => parseDesktopReleaseArgs(["aggregate", "root"])).toThrow("Invalid argument")

    const directory = mkdtempSync(join(tmpdir(), "alook-release-cli-"))
    temporaryDirectories.push(directory)
    const source = join(directory, "source")
    mkdirSync(source)

    await expect(runDesktopReleaseCli([
      "collect", "--target", "macos-aarch64", "--version", "bad", "--source", source, "--stage", join(directory, "stage"),
    ])).rejects.toThrow("numeric semver")
    await expect(runDesktopReleaseCli([
      "validate", "--stage", join(directory, "missing"), "--target", "macos-aarch64", "--version", version,
    ])).rejects.toThrow()
    await expect(runDesktopReleaseCli([
      "aggregate", "--root", directory, "--output", join(directory, "output"), "--version", version,
      "--repository", "invalid", "--pub-date", "invalid", "--config", join(directory, "config.json"),
    ])).rejects.toThrow("Invalid GitHub repository")
    await expect(runDesktopReleaseCli([
      "verify-published", "--manifest", join(directory, "missing-manifest.json"), "--release", join(directory, "missing-release.json"),
      "--latest", join(directory, "latest.json"), "--tag", "v1.2.3",
    ])).rejects.toThrow()
    await expect(runDesktopReleaseCli([
      "assert-publishable", "--release", join(directory, "missing-release.json"), "--tag", "invalid",
    ])).rejects.toThrow("numeric semver")
    await expect(runDesktopReleaseCli(["unknown"])).rejects.toThrow("Expected collect")

    const entryPath = join(directory, "desktop-release-artifacts.mjs")
    const stderr: string[] = []
    const runtime = {
      stderr: { write: (value: string) => stderr.push(value) },
      exitCode: 0,
    }
    await expect(runDesktopReleaseIfMain(pathToFileURL(entryPath).href, join(directory, "other.mjs"), [], runtime)).resolves.toBe(false)
    await expect(runDesktopReleaseIfMain(pathToFileURL(entryPath).href, entryPath, ["unknown"], runtime)).resolves.toBe(true)
    expect(stderr.join("")).toContain("Expected collect")
    expect(runtime.exitCode).toBe(1)
  })
})
