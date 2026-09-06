import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  BUILD_ARCHIVE_NAME,
  BUILD_MANIFEST_NAME,
  BUILD_OUTPUT_ROOTS,
  createBuildArtifact,
  runCli,
  verifyBuildArtifact,
} from "./e2e-build-artifact.mjs"

const HEAD_SHA = "a".repeat(40)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alook-ui-e2e-build-"))
  roots.push(root)
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
  })
  return { root, ...result }
}

function removeBuildOutputs(root: string) {
  for (const output of BUILD_OUTPUT_ROOTS) rmSync(join(root, output), { recursive: true })
}

describe("UI E2E build artifact", () => {
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
      version: 1,
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
    ["version", (manifest: Record<string, unknown>) => { manifest.version = 2 }, "version mismatch"],
    ["roots", (manifest: Record<string, unknown>) => { manifest.roots = [BUILD_OUTPUT_ROOTS[0]] }, "roots mismatch"],
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
