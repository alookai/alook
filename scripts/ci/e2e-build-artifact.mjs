import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { executeTurbo, taskEnvironment } from "./run-turbo.mjs"

export const BUILD_ARTIFACT_VERSION = 2
export const BUILD_ARCHIVE_NAME = "ui-e2e-build.tgz"
export const BUILD_MANIFEST_NAME = "ui-e2e-build-manifest.json"
export const BUILD_OUTPUT_ROOTS = [
  "src/web/.open-next",
  "src/web/blog/.open-next",
]
export const BUILD_ENTRYPOINTS = BUILD_OUTPUT_ROOTS.map((root) => `${root}/worker.js`)

export function buildOutputRoots(zones = ["web", "blog"]) {
  if (!Array.isArray(zones) || !zones.length || new Set(zones).size !== zones.length
    || zones.some(zone => !["web", "blog"].includes(zone))) throw new Error("invalid build zones")
  return ["web", "blog"].filter(zone => zones.includes(zone)).map(zone => zone === "web" ? "src/web/.open-next" : "src/web/blog/.open-next")
}

function nativeBuildHashes(root, outputRoots) {
  const tasks = outputRoots.map(path => path.includes("/blog/") ? "@alook/web#build:blog" : "@alook/web#build")
  const result = executeTurbo(["run", ...tasks, "--dry=json"], { root, stdio: ["ignore", "pipe", "pipe"] })
  if (result.error || result.status !== 0) throw new Error("native build identity query failed")
  const report = JSON.parse(result.stdout)
  const hashes = Object.fromEntries(report.tasks.filter(task => tasks.includes(task.taskId))
    .sort((left, right) => left.taskId.localeCompare(right.taskId)).map(task => [task.taskId, task.hash]))
  if (Object.keys(hashes).length !== tasks.length || Object.values(hashes).some(hash => !/^[a-f0-9]+$/.test(hash))) {
    throw new Error("native build identity is incomplete")
  }
  return hashes
}

function buildIdentity(root, outputRoots) {
  const packageManager = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).packageManager
  requiredString(packageManager, "package manager")
  const turbo = JSON.parse(readFileSync(resolve(root, "turbo.json"), "utf8"))
  const tasks = outputRoots.map(path => path.includes("/blog/") ? "@alook/web#build:blog" : "@alook/web#build")
  const patterns = [...turbo.globalEnv || [], ...tasks.flatMap(task => turbo.tasks[task].env || [])]
  const names = Object.keys(process.env).filter(name => !name.startsWith("ALOOK_TASK_")
    && patterns.some(pattern => pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern)).sort()
  const env = Object.fromEntries(names.map(name => [name, process.env[name]]))
  const files = {}
  for (const folder of ["src/web", ...(tasks.includes("@alook/web#build:blog") ? ["src/web/blog"] : [])]) {
    const absolute = resolve(root, folder)
    for (const name of existsSync(absolute) ? readdirSync(absolute).sort() : []) {
      if (/^(?:\.env|\.dev\.vars)(?:\..*)?$/.test(name) && statSync(resolve(absolute, name)).isFile()) {
        files[folder + "/" + name] = sha256File(resolve(absolute, name))
      }
    }
  }
  const environment = taskEnvironment(root)
  return {
    taskHashes: nativeBuildHashes(root, outputRoots),
    toolchain: { node: environment.ALOOK_TASK_NODE, bun: environment.ALOOK_TASK_BUN, platform: environment.ALOOK_TASK_PLATFORM, packageManager, workspace: realpathSync(root) },
    environmentSha256: createHash("sha256").update(JSON.stringify({ env, files })).digest("hex"),
  }
}

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

export function assertBuildOutputs(root, roots = BUILD_OUTPUT_ROOTS) {
  for (const entrypoint of roots.map(path => `${path}/worker.js`)) {
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

export function verifyArchiveMembers(archive, roots = BUILD_OUTPUT_ROOTS) {
  const members = runTar(["-tzf", archive])
    .split("\n")
    .filter(Boolean)
    .map(normalizedArchiveMember)
  if (members.length === 0) throw new Error("build archive is empty")
  for (const member of members) {
    const segments = member.split("/")
    const allowed = roots.some(
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
  for (const entrypoint of roots.map(path => `${path}/worker.js`)) {
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
    "environmentSha256",
    "headSha",
    "lockfileSha256",
    "roots",
    "runId",
    "taskHashes",
    "toolchain",
    "version",
  ]
  expected.sort()
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

export function createBuildArtifact({ root, directory, runId, attempt, headSha, zones }) {
  const repositoryRoot = resolve(root)
  const identity = {
    runId: requiredString(String(runId ?? ""), "run ID"),
    attempt: positiveInteger(attempt, "attempt"),
    headSha: exactHeadSha(headSha),
  }
  const lockfile = resolve(repositoryRoot, "pnpm-lock.yaml")
  assertRegularFile(lockfile, "pnpm lockfile")
  const outputRoots = buildOutputRoots(zones)
  assertBuildOutputs(repositoryRoot, outputRoots)

  const paths = artifactPaths(repositoryRoot, directory)
  mkdirSync(paths.artifactDirectory, { recursive: true })
  rmSync(paths.archive, { force: true })
  rmSync(paths.manifest, { force: true })
  runTar(["-czf", paths.archive, "-C", repositoryRoot, ...outputRoots])
  verifyArchiveMembers(paths.archive, outputRoots)

  const manifest = {
    version: BUILD_ARTIFACT_VERSION,
    ...identity,
    lockfileSha256: sha256File(lockfile),
    archiveSha256: sha256File(paths.archive),
    roots: outputRoots,
    ...buildIdentity(repositoryRoot, outputRoots),
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

export function verifyBuildArtifact({ root, directory, runId, attempt, headSha, zones }) {
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
  const outputRoots = buildOutputRoots(zones)
  if (
    !Array.isArray(manifest.roots)
    || manifest.roots.length !== outputRoots.length
    || manifest.roots.some((value, index) => value !== outputRoots[index])
  ) {
    throw new Error("build output roots mismatch")
  }
  assertManifestDigest(manifest.lockfileSha256, "lockfile digest")
  assertManifestDigest(manifest.archiveSha256, "archive digest")

  const lockfile = resolve(repositoryRoot, "pnpm-lock.yaml")
  assertRegularFile(lockfile, "pnpm lockfile")
  assertEqual(sha256File(lockfile), manifest.lockfileSha256, "build lockfile SHA-256")
  assertEqual(sha256File(paths.archive), manifest.archiveSha256, "build archive SHA-256")
  const currentIdentity = buildIdentity(repositoryRoot, outputRoots)
  assertEqual(JSON.stringify(manifest.toolchain), JSON.stringify(currentIdentity.toolchain), "build toolchain")
  assertManifestDigest(manifest.environmentSha256, "build environment digest")
  assertEqual(manifest.environmentSha256, currentIdentity.environmentSha256, "build environment")
  assertEqual(JSON.stringify(manifest.taskHashes), JSON.stringify(currentIdentity.taskHashes), "native build task hashes")
  verifyArchiveMembers(paths.archive, outputRoots)

  for (const outputRoot of outputRoots) {
    rmSync(resolve(repositoryRoot, outputRoot), { recursive: true, force: true })
  }
  runTar(["-xzpf", paths.archive, "-C", repositoryRoot])
  assertBuildOutputs(repositoryRoot, outputRoots)
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
    zones: args.zones ? args.zones.split(",") : undefined,
  }
  if (args.command === "create") return createBuildArtifact(options)
  if (args.command === "verify") return verifyBuildArtifact(options)
  throw new Error("expected create or verify command")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
}
