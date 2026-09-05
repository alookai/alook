import { execFileSync, spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildExecutionPlan,
  loadScopeManifest,
  parseNameStatus,
  validateExecutionPlan,
} from "./changed-scopes.mjs"

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const FULL_SHA = /^[0-9a-f]{40}$/
const CLASSES = new Set(["auth", "blog", "package", "shared"])

export function validateCharacterization(input) {
  const {
    repository,
    refName,
    eventSha,
    candidateSha,
    fixtureSha,
    expectedClass,
    candidatePr,
    refSha,
    parentShas,
    isAncestor,
    fileMode,
    changes,
    plan,
    integrityBlobs,
    manifest,
  } = input

  for (const [name, value] of Object.entries({ eventSha, candidateSha, fixtureSha, refSha })) {
    if (!FULL_SHA.test(value)) throw new Error(`${name} must be a full lowercase SHA`)
  }
  if (!CLASSES.has(expectedClass)) throw new Error("invalid expected characterization class")
  if (refName !== `ci-characterization/${candidateSha.slice(0, 12)}/${expectedClass}`) {
    throw new Error("characterization ref does not match the fixed branch prefix")
  }
  if (eventSha !== fixtureSha || refSha !== fixtureSha) {
    throw new Error("fixture SHA must match both the dispatch event SHA and branch ref tip")
  }
  if (candidatePr?.state !== "open") throw new Error("candidate PR must remain open")
  if (candidatePr?.head?.repo?.full_name !== repository) {
    throw new Error("candidate PR and fixture must belong to the same repository")
  }
  if (candidatePr?.head?.sha !== candidateSha) {
    throw new Error("candidate PR head no longer matches the locked candidate SHA")
  }
  if (parentShas.length !== 1 || parentShas[0] !== candidateSha) {
    throw new Error("fixture must be a single-parent direct child of the candidate")
  }
  if (!isAncestor) throw new Error("candidate must be an ancestor of fixture")
  if (fileMode !== "100644" && fileMode !== "100755") {
    throw new Error("characterization fixture must modify a regular source file")
  }
  if (changes.length !== 1) throw new Error("characterization requires a single source change")
  if (changes[0].status !== "M" || changes[0].old_path) {
    throw new Error("characterization fixture must modify one existing source file")
  }

  const integrityKeys = Object.keys(integrityBlobs).sort()
  const expectedIntegrity = [...manifest.integrity_paths].sort()
  if (JSON.stringify(integrityKeys) !== JSON.stringify(expectedIntegrity)) {
    throw new Error("characterization integrity blob set does not match the manifest")
  }
  for (const [path, blobs] of Object.entries(integrityBlobs)) {
    if (blobs.candidate !== blobs.fixture) {
      throw new Error(`characterization policy blob changed: ${path}`)
    }
  }

  validateExecutionPlan(plan, { manifest })
  if (!plan.diagnostic_only) throw new Error("characterization plan must be diagnostic-only")
  if (plan.base_sha !== candidateSha || plan.head_sha !== fixtureSha) {
    throw new Error("characterization plan SHA boundary mismatch")
  }
  if (plan.full || !CLASSES.has(plan.change_class) || plan.change_class !== expectedClass) {
    throw new Error(`characterization classifier class mismatch: ${plan.change_class}`)
  }
  if (plan.coverage.required_changed_files.length !== 1
    || plan.coverage.required_changed_files[0] !== changes[0].path) {
    throw new Error("characterization fixture path must be coverable")
  }

  return {
    schema_version: manifest.schema_version,
    policy_version: manifest.policy_version,
    base_sha: candidateSha,
    head_sha: fixtureSha,
    expected_class: expectedClass,
    diagnostic_only: true,
    source_path: changes[0].path,
    plan_hash: plan.plan_hash,
    integrity_paths: expectedIntegrity,
  }
}

function git(args, options = {}, runtime = {}) {
  const execute = runtime.execFileSync || execFileSync
  return execute("git", args, {
    cwd: runtime.root || ROOT,
    ...(options.buffer ? {} : { encoding: "utf8" }),
    stdio: ["ignore", "pipe", "pipe"],
  })
}

export function blobAt(sha, path, runtime = {}) {
  const spawn = runtime.spawnSync || spawnSync
  const result = spawn("git", ["rev-parse", `${sha}:${path}`], {
    cwd: runtime.root || ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.status === 0) return result.stdout.trim()
  if (result.stderr.includes("exists on disk, but not in")) return null
  if (result.stderr.includes("does not exist in")) return null
  throw new Error(`cannot resolve integrity path ${path}: ${result.stderr.trim()}`)
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++index]
  }
  return args
}

export function runCli(argv, runtime = {}) {
  const args = parseArgs(argv)
  for (const required of [
    "repository", "refName", "eventSha", "candidateSha", "fixtureSha",
    "expectedClass", "candidatePrJson",
  ]) {
    if (!args[required]) throw new Error(`--${required} is required`)
  }
  const manifest = runtime.manifest || loadScopeManifest()
  const candidatePr = JSON.parse(readFileSync(resolve(args.candidatePrJson), "utf8"))
  const remoteRef = git(["ls-remote", "--heads", "origin", `refs/heads/${args.refName}`], {}, runtime)
    .trim()
    .split(/\s+/)[0]
  const parentShas = git(["show", "-s", "--format=%P", args.fixtureSha], {}, runtime).trim().split(/\s+/).filter(Boolean)
  const spawn = runtime.spawnSync || spawnSync
  const ancestor = spawn("git", ["merge-base", "--is-ancestor", args.candidateSha, args.fixtureSha], {
    cwd: runtime.root || ROOT,
    stdio: "ignore",
  }).status === 0
  const changes = parseNameStatus(git(
    ["diff", "--name-status", "-z", "--find-renames", "--find-copies", args.candidateSha, args.fixtureSha],
    { buffer: true },
    runtime,
  ))
  const fileMode = changes.length === 1
    ? git(["ls-tree", args.fixtureSha, "--", changes[0].path], {}, runtime).trim().split(/\s+/)[0]
    : ""
  const plan = buildExecutionPlan(changes, {
    baseSha: args.candidateSha,
    headSha: args.fixtureSha,
    diagnosticOnly: true,
  })
  const integrityBlobs = Object.fromEntries(manifest.integrity_paths.map((path) => [path, {
    candidate: blobAt(args.candidateSha, path, runtime),
    fixture: blobAt(args.fixtureSha, path, runtime),
  }]))
  const result = validateCharacterization({
    repository: args.repository,
    refName: args.refName,
    eventSha: args.eventSha,
    candidateSha: args.candidateSha,
    fixtureSha: args.fixtureSha,
    expectedClass: args.expectedClass,
    candidatePr,
    refSha: remoteRef,
    parentShas,
    isAncestor: ancestor,
    fileMode,
    changes,
    plan,
    integrityBlobs,
    manifest,
  })
  if (args.output) {
    appendFileSync(args.output, `base_sha=${result.base_sha}\nhead_sha=${result.head_sha}\ndiagnostic_only=true\n`)
  }
  if (args.summary) {
    appendFileSync(
      args.summary,
      `## Characterization guard\n\n- Candidate: \`${result.base_sha}\`\n- Fixture: \`${result.head_sha}\`\n- Class: \`${result.expected_class}\`\n- Source: \`${result.source_path}\`\n- Policy blobs: \`${result.integrity_paths.length}\` identical\n`,
    )
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

export function runIfMain(
  metaUrl,
  argvPath = process.argv[1],
  argv = process.argv.slice(2),
  runtime = {},
) {
  if (argvPath === fileURLToPath(metaUrl)) {
    runCli(argv, runtime)
  }
}

runIfMain(import.meta.url)
