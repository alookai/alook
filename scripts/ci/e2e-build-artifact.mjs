import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const BUILD_ARTIFACT_VERSION = 1
export const BUILD_ARCHIVE_NAME = "ui-e2e-build.tgz"
export const BUILD_MANIFEST_NAME = "ui-e2e-build-manifest.json"
export const BUILD_OUTPUT_ROOTS = [
  "src/web/.open-next",
  "src/web/blog/.open-next",
]
export const BUILD_ENTRYPOINTS = BUILD_OUTPUT_ROOTS.map((root) => `${root}/worker.js`)

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function exactHeadSha(value) {
  const sha = requiredString(value, "head SHA")
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("head SHA must be an exact lowercase 40-character commit SHA")
  }
  return sha
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function assertRegularFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing: ${path}`)
  }
}

export function assertBuildOutputs(root) {
  for (const entrypoint of BUILD_ENTRYPOINTS) {
    assertRegularFile(resolve(root, entrypoint), "OpenNext worker entrypoint")
  }
}

function runTar(args) {
  const scratch = mkdtempSync(join(tmpdir(), "alook-ui-e2e-tar-"))
  const stdoutPath = join(scratch, "stdout")
  const stderrPath = join(scratch, "stderr")
  let stdoutFd
  let stderrFd
  try {
    stdoutFd = openSync(stdoutPath, "w")
    stderrFd = openSync(stderrPath, "w")
    const result = spawnSync("tar", args, {
      stdio: ["ignore", stdoutFd, stderrFd],
    })
    closeSync(stdoutFd)
    stdoutFd = undefined
    closeSync(stderrFd)
    stderrFd = undefined

    if (result.error) throw new Error(`tar failed to start: ${result.error.message}`)
    const detail = readFileSync(stderrPath, "utf8").trim().slice(0, 4_096)
    if (result.signal) {
      throw new Error(`tar terminated by signal ${result.signal}${detail ? `: ${detail}` : ""}`)
    }
    if (result.status === null) throw new Error("tar failed without an exit status")
    if (result.status !== 0) {
      throw new Error(`tar failed with exit ${String(result.status)}${detail ? `: ${detail}` : ""}`)
    }
    return readFileSync(stdoutPath, "utf8")
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
    rmSync(scratch, { recursive: true, force: true })
  }
}

function normalizedArchiveMember(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value
}

export function verifyArchiveMembers(archive) {
  const members = runTar(["-tzf", archive])
    .split("\n")
    .filter(Boolean)
    .map(normalizedArchiveMember)
  if (members.length === 0) throw new Error("build archive is empty")
  for (const member of members) {
    const segments = member.split("/")
    const allowed = BUILD_OUTPUT_ROOTS.some(
      (root) => member === root || member.startsWith(`${root}/`),
    )
    if (
      member.startsWith("/")
      || member.includes("\\")
      || segments.includes("..")
      || !allowed
    ) {
      throw new Error(`build archive contains an unexpected member: ${member}`)
    }
  }
  for (const entrypoint of BUILD_ENTRYPOINTS) {
    if (!members.includes(entrypoint)) {
      throw new Error(`build archive is missing OpenNext worker entrypoint: ${entrypoint}`)
    }
  }
  return members
}

function exactManifestKeys(manifest) {
  const expected = [
    "archiveSha256",
    "attempt",
    "headSha",
    "lockfileSha256",
    "roots",
    "runId",
    "version",
  ]
  const actual = Object.keys(manifest).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("build manifest fields do not match the exact contract")
  }
}

function artifactPaths(root, directory) {
  const repositoryRoot = resolve(root)
  const artifactDirectory = resolve(repositoryRoot, directory)
  if (!artifactDirectory.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("artifact directory must be inside the repository root")
  }
  return {
    artifactDirectory,
    archive: resolve(artifactDirectory, BUILD_ARCHIVE_NAME),
    manifest: resolve(artifactDirectory, BUILD_MANIFEST_NAME),
  }
}

export function createBuildArtifact({ root, directory, runId, attempt, headSha }) {
  const repositoryRoot = resolve(root)
  const identity = {
    runId: requiredString(String(runId ?? ""), "run ID"),
    attempt: positiveInteger(attempt, "attempt"),
    headSha: exactHeadSha(headSha),
  }
  const lockfile = resolve(repositoryRoot, "pnpm-lock.yaml")
  assertRegularFile(lockfile, "pnpm lockfile")
  assertBuildOutputs(repositoryRoot)

  const paths = artifactPaths(repositoryRoot, directory)
  mkdirSync(paths.artifactDirectory, { recursive: true })
  rmSync(paths.archive, { force: true })
  rmSync(paths.manifest, { force: true })
  runTar(["-czf", paths.archive, "-C", repositoryRoot, ...BUILD_OUTPUT_ROOTS])
  verifyArchiveMembers(paths.archive)

  const manifest = {
    version: BUILD_ARTIFACT_VERSION,
    ...identity,
    lockfileSha256: sha256File(lockfile),
    archiveSha256: sha256File(paths.archive),
    roots: BUILD_OUTPUT_ROOTS,
  }
  writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return { ...paths, manifestData: manifest }
}

function assertManifestDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`)
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`)
  }
}

export function verifyBuildArtifact({ root, directory, runId, attempt, headSha }) {
  const repositoryRoot = resolve(root)
  const paths = artifactPaths(repositoryRoot, directory)
  assertRegularFile(paths.archive, "build archive")
  assertRegularFile(paths.manifest, "build manifest")

  let manifest
  try {
    manifest = JSON.parse(readFileSync(paths.manifest, "utf8"))
  } catch (error) {
    throw new Error(`build manifest is invalid JSON: ${String(error)}`)
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("build manifest must be an object")
  }
  exactManifestKeys(manifest)
  assertEqual(manifest.version, BUILD_ARTIFACT_VERSION, "build manifest version")
  assertEqual(manifest.runId, requiredString(String(runId ?? ""), "run ID"), "build run ID")
  assertEqual(manifest.attempt, positiveInteger(attempt, "attempt"), "build attempt")
  assertEqual(manifest.headSha, exactHeadSha(headSha), "build head SHA")
  if (
    !Array.isArray(manifest.roots)
    || manifest.roots.length !== BUILD_OUTPUT_ROOTS.length
    || manifest.roots.some((value, index) => value !== BUILD_OUTPUT_ROOTS[index])
  ) {
    throw new Error("build output roots mismatch")
  }
  assertManifestDigest(manifest.lockfileSha256, "lockfile digest")
  assertManifestDigest(manifest.archiveSha256, "archive digest")

  const lockfile = resolve(repositoryRoot, "pnpm-lock.yaml")
  assertRegularFile(lockfile, "pnpm lockfile")
  assertEqual(sha256File(lockfile), manifest.lockfileSha256, "build lockfile SHA-256")
  assertEqual(sha256File(paths.archive), manifest.archiveSha256, "build archive SHA-256")
  verifyArchiveMembers(paths.archive)

  for (const outputRoot of BUILD_OUTPUT_ROOTS) {
    rmSync(resolve(repositoryRoot, outputRoot), { recursive: true, force: true })
  }
  runTar(["-xzf", paths.archive, "-C", repositoryRoot])
  assertBuildOutputs(repositoryRoot)
  return manifest
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (!key || rest[index + 1] === undefined) throw new Error(`invalid argument: ${rest[index] ?? ""}`)
    args[key] = rest[index + 1]
  }
  return args
}

export function runCli(argv) {
  const args = parseArgs(argv)
  const options = {
    root: args.root ?? process.cwd(),
    directory: args.directory ?? ".ci/ui-e2e-build",
    runId: args.runId,
    attempt: args.attempt,
    headSha: args.headSha,
  }
  if (args.command === "create") return createBuildArtifact(options)
  if (args.command === "verify") return verifyBuildArtifact(options)
  throw new Error("expected create or verify command")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}
