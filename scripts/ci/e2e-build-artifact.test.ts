import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUILD_ARCHIVE_NAME,
  BUILD_MANIFEST_NAME,
  BUILD_OUTPUT_ROOTS,
  createBuildArtifact,
  runCli,
  verifyArchiveMembers,
  verifyBuildArtifact,
} from "./e2e-build-artifact.mjs"

const HEAD_SHA = "a".repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fixture(zones?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "alook-ui-e2e-build-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "artifact-fixture", packageManager: "pnpm@10.33.0" }))
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "src/web"\n')
  writeFileSync(join(root, ".gitignore"), "node_modules\n")
  mkdirSync(join(root, "src/web"), { recursive: true })
  writeFileSync(join(root, "src/web/package.json"), JSON.stringify({ name: "@alook/web", scripts: { build: "node -e 0", "build:blog": "node -e 0" } }))
  writeFileSync(join(root, "src/web/source.ts"), "export const value = 1\n")
  symlinkSync(resolve(import.meta.dirname, "../../node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  writeFileSync(join(root, "turbo.json"), JSON.stringify({ globalEnv: ["CI", "ALOOK_TASK_NODE", "ALOOK_TASK_PLATFORM", "ALOOK_TASK_WORKSPACE"], tasks: {
    "@alook/web#build": { env: ["NEXT_PUBLIC_*"], inputs: ["package.json", "source.ts"], outputs: [".open-next/**"] },
    "@alook/web#build:blog": { env: ["NEXT_PUBLIC_*"], inputs: ["package.json", "source.ts"], outputs: ["blog/.open-next/**"] },
  } }))
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  for (const output of BUILD_OUTPUT_ROOTS) {
    mkdirSync(join(root, output, "assets"), { recursive: true })
    writeFileSync(join(root, output, "worker.js"), `export default ${JSON.stringify(output)}\n`)
    writeFileSync(join(root, output, "assets", "asset.txt"), output)
  }
  const result = createBuildArtifact({
    root,
    directory: ".ci/ui-e2e-build",
    runId: "123",
    attempt: 2,
    headSha: HEAD_SHA,
    zones,
  })
  return { root, ...result }
}

function removeBuildOutputs(root: string) {
  for (const output of BUILD_OUTPUT_ROOTS) rmSync(join(root, output), { recursive: true })
}

describe("UI E2E build artifact", () => {
  it("preserves archived executable modes under a restrictive consumer umask", () => {
    const artifact = fixture()
    const entry = join(artifact.root, BUILD_OUTPUT_ROOTS[0]!, "worker.js")
    chmodSync(entry, 0o751)
    const options = { root: artifact.root, directory: ".ci/ui-e2e-build", runId: "123", attempt: 2, headSha: HEAD_SHA }
    createBuildArtifact(options)
    removeBuildOutputs(artifact.root)
    const previous = process.umask(0o077)
    try {
      verifyBuildArtifact(options)
      if (process.platform !== "win32") expect(lstatSync(entry).mode & 0o777).toBe(0o751)
      expect(readFileSync(entry, "utf8")).toContain("export default")
    } finally { process.umask(previous) }
  })

  it("round-trips Web alone and rejects a consumer that additionally requires Blog", () => {
    const artifact = fixture(["web"])
    removeBuildOutputs(artifact.root)
    const options = { root: artifact.root, directory: ".ci/ui-e2e-build", runId: "123", attempt: 2, headSha: HEAD_SHA }
    expect(() => verifyBuildArtifact(options)).toThrow("roots mismatch")
    expect(verifyBuildArtifact({ ...options, zones: ["web"] }).roots).toEqual([BUILD_OUTPUT_ROOTS[0]])
    expect(readFileSync(join(artifact.root, BUILD_OUTPUT_ROOTS[0], "worker.js"), "utf8")).toContain("export default")
    expect(verifyArchiveMembers(artifact.archive, [BUILD_OUTPUT_ROOTS[0]]).some(path => path.includes("/blog/"))).toBe(false)
  })

  it("rejects a different build environment without exposing its values", () => {
    const artifact = fixture()
    vi.stubEnv("NEXT_PUBLIC_WS_DO_PORT", "8765")
    expect(() => verifyBuildArtifact({ root: artifact.root, directory: ".ci/ui-e2e-build", runId: "123", attempt: 2, headSha: HEAD_SHA })).toThrow("build environment mismatch")
  })

  it.each(["source", "configuration"])("rejects changed %s through native Turbo task hashes", kind => {
    const artifact = fixture()
    if (kind === "source") writeFileSync(join(artifact.root, "src/web/source.ts"), "export const value = 2\n")
    else {
      const path = join(artifact.root, "turbo.json")
      const config = JSON.parse(readFileSync(path, "utf8"))
      config.tasks["@alook/web#build"].outputs.push("another-output/**")
      writeFileSync(path, JSON.stringify(config))
    }
    expect(() => verifyBuildArtifact({ root: artifact.root, directory: ".ci/ui-e2e-build", runId: "123", attempt: 2, headSha: HEAD_SHA })).toThrow("native build task hashes mismatch")
  })

  it("rejects incomplete create identities before reading the filesystem", () => {
    const options = {
      root: ".",
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    }

    expect(() => createBuildArtifact({ ...options, runId: "" }))
      .toThrow("run ID is required")
    expect(() => createBuildArtifact({ ...options, attempt: 0 }))
      .toThrow("attempt must be a positive integer")
    expect(() => createBuildArtifact({ ...options, headSha: "A".repeat(40) }))
      .toThrow("head SHA must be an exact lowercase 40-character commit SHA")
  })

  it("round-trips both hidden OpenNext trees with exact run identity and digests", () => {
    const artifact = fixture()
    removeBuildOutputs(artifact.root)

    const manifest = verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })

    expect(manifest).toMatchObject({
      version: 2,
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
      roots: BUILD_OUTPUT_ROOTS,
    })
    expect(manifest.lockfileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    for (const output of BUILD_OUTPUT_ROOTS) {
      expect(readFileSync(join(artifact.root, output, "assets", "asset.txt"), "utf8"))
        .toBe(output)
    }
  })

  it("verifies a real archive listing larger than spawnSync's default buffer", () => {
    const artifact = fixture()
    const listingRoot = join(
      artifact.root,
      BUILD_OUTPUT_ROOTS[0],
      "assets",
      "large-listing",
    )
    mkdirSync(listingRoot, { recursive: true })
    for (let index = 0; index < 5_200; index += 1) {
      writeFileSync(
        join(listingRoot, `${String(index).padStart(5, "0")}-${"x".repeat(180)}.txt`),
        "",
      )
    }
    const large = createBuildArtifact({
      root: artifact.root,
      directory: ".ci/large-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })
    const listing = spawnSync("tar", ["-tzf", large.archive], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    })
    expect(listing.status).toBe(0)
    expect(Buffer.byteLength(listing.stdout)).toBeGreaterThan(1024 * 1024)

    removeBuildOutputs(artifact.root)
    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/large-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).not.toThrow()
  }, 15_000)

  it.each([
    ["run ID", { runId: "124", attempt: 2, headSha: HEAD_SHA }],
    ["attempt", { runId: "123", attempt: 3, headSha: HEAD_SHA }],
    ["head SHA", { runId: "123", attempt: 2, headSha: "b".repeat(40) }],
  ])("rejects the wrong %s before extraction", (_, identity) => {
    const artifact = fixture()
    removeBuildOutputs(artifact.root)

    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      ...identity,
    })).toThrow("mismatch")
    for (const output of BUILD_OUTPUT_ROOTS) {
      expect(() => readFileSync(join(artifact.root, output, "worker.js"), "utf8")).toThrow()
    }
  })

  it("rejects lockfile and archive corruption", () => {
    const lockfileArtifact = fixture()
    writeFileSync(join(lockfileArtifact.root, "pnpm-lock.yaml"), "changed\n")
    expect(() => verifyBuildArtifact({
      root: lockfileArtifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("lockfile SHA-256 mismatch")

    const archiveArtifact = fixture()
    writeFileSync(archiveArtifact.archive, "corrupt")
    expect(() => verifyBuildArtifact({
      root: archiveArtifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("archive SHA-256 mismatch")
  })

  it("reports tar child launch, signal, and exit failures explicitly", () => {
    const artifact = fixture()
    const corruptArchive = join(artifact.root, "corrupt.tgz")
    writeFileSync(corruptArchive, "not a tar archive")
    expect(() => verifyArchiveMembers(corruptArchive)).toThrow(/tar failed with exit [1-9]\d*/)

    const originalPath = process.env.PATH
    const signalBin = join(artifact.root, "signal-bin")
    mkdirSync(signalBin)
    writeFileSync(join(signalBin, "tar"), "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 })
    process.env.PATH = signalBin
    try {
      expect(() => verifyArchiveMembers(artifact.archive))
        .toThrow("tar terminated by signal SIGTERM")
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }

    process.env.PATH = join(artifact.root, "missing-bin")
    try {
      expect(() => verifyArchiveMembers(artifact.archive)).toThrow("tar failed to start:")
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })

  it("fails closed when either artifact file is missing", () => {
    const missingArchive = fixture()
    rmSync(missingArchive.archive)
    expect(() => verifyBuildArtifact({
      root: missingArchive.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("build archive is missing")

    const missingManifest = fixture()
    rmSync(missingManifest.manifest)
    expect(() => verifyBuildArtifact({
      root: missingManifest.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("build manifest is missing")
  })

  it.each([
    ["extra fields", (manifest: Record<string, unknown>) => { manifest.extra = true }, "exact contract"],
    ["version", (manifest: Record<string, unknown>) => { manifest.version = 999 }, "version mismatch"],
    ["roots", (manifest: Record<string, unknown>) => { manifest.roots = [BUILD_OUTPUT_ROOTS[0]] }, "roots mismatch"],
    ["Node release", (manifest: Record<string, unknown>) => { manifest.toolchain = { ...(manifest.toolchain as Record<string, unknown>), node: "0.0.0" } }, "build toolchain mismatch"],
    ["lockfile digest", (manifest: Record<string, unknown>) => { manifest.lockfileSha256 = "invalid" }, "lockfile digest"],
    ["archive digest", (manifest: Record<string, unknown>) => { manifest.archiveSha256 = "invalid" }, "archive digest"],
  ])("rejects invalid manifest %s", (_name, mutate, error) => {
    const artifact = fixture()
    const manifest = JSON.parse(readFileSync(artifact.manifest, "utf8")) as Record<string, unknown>
    mutate(manifest)
    writeFileSync(artifact.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow(error)
  })

  it.each([
    ["invalid JSON", "{", "invalid JSON"],
    ["a non-object", "[]", "must be an object"],
  ])("rejects a manifest containing %s", (_name, contents, error) => {
    const artifact = fixture()
    writeFileSync(artifact.manifest, contents)

    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow(error)
  })

  it("rejects unexpected archive members even when the manifest digest matches", () => {
    const artifact = fixture()
    writeFileSync(join(artifact.root, "unexpected.txt"), "unexpected")
    const tar = spawnSync("tar", [
      "-czf",
      artifact.archive,
      "-C",
      artifact.root,
      ...BUILD_OUTPUT_ROOTS,
      "unexpected.txt",
    ])
    expect(tar.status).toBe(0)
    const manifest = JSON.parse(readFileSync(artifact.manifest, "utf8"))
    manifest.archiveSha256 = createHash("sha256")
      .update(readFileSync(artifact.archive))
      .digest("hex")
    writeFileSync(artifact.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("unexpected member: unexpected.txt")
  })

  it("rejects an archive missing either worker even when the manifest digest matches", () => {
    const artifact = fixture()
    rmSync(join(artifact.root, BUILD_OUTPUT_ROOTS[1], "worker.js"))
    const tar = spawnSync("tar", [
      "-czf",
      artifact.archive,
      "-C",
      artifact.root,
      ...BUILD_OUTPUT_ROOTS,
    ])
    expect(tar.status).toBe(0)
    const manifest = JSON.parse(readFileSync(artifact.manifest, "utf8"))
    manifest.archiveSha256 = createHash("sha256")
      .update(readFileSync(artifact.archive))
      .digest("hex")
    writeFileSync(artifact.manifest, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(() => verifyBuildArtifact({
      root: artifact.root,
      directory: ".ci/ui-e2e-build",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow(`missing OpenNext worker entrypoint: ${BUILD_OUTPUT_ROOTS[1]}/worker.js`)
  })

  it("requires both worker entrypoints and exposes strict create/verify CLI commands", () => {
    const artifact = fixture()
    rmSync(join(artifact.root, BUILD_OUTPUT_ROOTS[1], "worker.js"))
    expect(() => createBuildArtifact({
      root: artifact.root,
      directory: ".ci/second",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("OpenNext worker entrypoint is missing")

    removeBuildOutputs(artifact.root)
    expect(() => runCli([
      "verify",
      "--root", artifact.root,
      "--directory", ".ci/ui-e2e-build",
      "--run-id", "123",
      "--attempt", "2",
      "--head-sha", HEAD_SHA,
    ])).not.toThrow()
    expect(() => runCli(["unknown"])).toThrow("expected create or verify")
    expect(artifact.archive).toBe(join(artifact.artifactDirectory, BUILD_ARCHIVE_NAME))
    expect(artifact.manifest).toBe(join(artifact.artifactDirectory, BUILD_MANIFEST_NAME))
  })

  it("executes the direct CLI entrypoint", async () => {
    const cliPath = fileURLToPath(new URL("./e2e-build-artifact.mjs", import.meta.url))
    const result = spawnSync(process.execPath, [cliPath, "unknown"], { encoding: "utf8" })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("expected create or verify command")

    const originalArgv = [...process.argv]
    process.argv.splice(0, process.argv.length, process.execPath, cliPath, "unknown")
    vi.resetModules()
    try {
      await expect(import("./e2e-build-artifact.mjs"))
        .rejects.toThrow("expected create or verify command")
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
    }
  })

  it("refuses artifact directories outside the repository", () => {
    const artifact = fixture()
    expect(() => createBuildArtifact({
      root: artifact.root,
      directory: "../outside",
      runId: "123",
      attempt: 2,
      headSha: HEAD_SHA,
    })).toThrow("inside the repository root")
  })
})
