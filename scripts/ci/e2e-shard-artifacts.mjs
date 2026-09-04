import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const SHARD_ARTIFACT_PREFIX = "blob-report"
export const SHARD_MANIFEST_VERSION = 1

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export function normalizeSpecPath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "")
  const marker = "src/test/e2e-ui/"
  const markerIndex = normalized.indexOf(marker)
  return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized
}

export function expectedMatrix(matrixInput) {
  const matrix = typeof matrixInput === "string" ? JSON.parse(matrixInput) : matrixInput
  if (!matrix || !Array.isArray(matrix.include) || matrix.include.length === 0) {
    throw new Error("E2E matrix must contain a non-empty include array")
  }

  const shards = new Map()
  const owners = new Map()
  let total = null
  for (const entry of matrix.include) {
    const shard = parsePositiveInteger(entry.shard, "matrix shard")
    const entryTotal = parsePositiveInteger(entry.total, "matrix total")
    if (total == null) total = entryTotal
    if (total !== entryTotal) throw new Error("E2E matrix totals must agree")
    if (shards.has(shard)) throw new Error(`duplicate matrix shard ${shard}`)
    if (!Array.isArray(entry.specs) || entry.specs.length === 0) {
      throw new Error(`matrix shard ${shard} must contain specs`)
    }
    const specs = entry.specs.map(normalizeSpecPath).sort()
    if (new Set(specs).size !== specs.length) throw new Error(`duplicate spec within matrix shard ${shard}`)
    for (const spec of specs) {
      const owner = owners.get(spec)
      if (owner) throw new Error(`spec ${spec} is assigned to shards ${owner} and ${shard}`)
      owners.set(spec, shard)
    }
    shards.set(shard, { shard, total: entryTotal, specs })
  }
  if (shards.size !== total) throw new Error(`matrix declares ${total} shards but contains ${shards.size}`)
  for (let shard = 1; shard <= total; shard += 1) {
    if (!shards.has(shard)) throw new Error(`matrix is missing shard ${shard}`)
  }
  return { total, shards, specs: [...owners.keys()].sort() }
}

export function createShardManifest({ runId, attempt, sha, shard, total, specs }) {
  const manifest = {
    version: SHARD_MANIFEST_VERSION,
    runId: String(runId),
    attempt: parsePositiveInteger(attempt, "manifest attempt"),
    sha: String(sha),
    shard: parsePositiveInteger(shard, "manifest shard"),
    total: parsePositiveInteger(total, "manifest total"),
    specs: specs.map(normalizeSpecPath).sort(),
  }
  if (!manifest.runId) throw new Error("manifest runId is required")
  if (!manifest.sha) throw new Error("manifest sha is required")
  return manifest
}

export function resolveExecutedShards({ jobs, runStartedAt, expectedTotal }) {
  const startedAt = Date.parse(runStartedAt)
  if (!Number.isFinite(startedAt)) throw new Error(`invalid run_started_at: ${runStartedAt}`)
  const roster = new Set()
  const executed = new Set()
  for (const job of jobs) {
    const match = /^UI Playwright E2E \((\d+)\/(\d+)\)$/.exec(job.name ?? "")
    if (!match) continue
    const shard = parsePositiveInteger(match[1], "job shard")
    const total = parsePositiveInteger(match[2], "job total")
    if (total !== expectedTotal) throw new Error(`job ${job.name} does not match matrix total ${expectedTotal}`)
    if (shard > expectedTotal) throw new Error(`job ${job.name} has an out-of-range shard`)
    if (roster.has(shard)) throw new Error(`attempt job roster contains duplicate shard ${shard}`)
    roster.add(shard)
    const jobStartedAt = Date.parse(job.started_at)
    if (!Number.isFinite(jobStartedAt)) throw new Error(`job ${job.name} has invalid started_at`)
    if (jobStartedAt < startedAt) continue
    if (executed.has(shard)) throw new Error(`current attempt contains duplicate execution for shard ${shard}`)
    executed.add(shard)
  }
  const missing = Array.from(
    { length: expectedTotal },
    (_, index) => index + 1,
  ).filter((shard) => !roster.has(shard))
  if (missing.length > 0) {
    throw new Error(`attempt job roster is missing UI Playwright shards: ${missing.join(", ")}`)
  }
  return executed
}

async function fetchJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`)
  return response.json()
}

export async function fetchExecutedShards({
  repository,
  runId,
  attempt,
  expectedTotal,
  token,
  fetchImpl = fetch,
  apiUrl = "https://api.github.com",
}) {
  if (!repository || !token) throw new Error("repository and GitHub token are required")
  const run = await fetchJson(fetchImpl, `${apiUrl}/repos/${repository}/actions/runs/${runId}`, token)
  if (Number(run.run_attempt) !== Number(attempt)) {
    throw new Error(`GitHub run attempt ${run.run_attempt} does not match ${attempt}`)
  }

  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = await fetchJson(
      fetchImpl,
      `${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      token,
    )
    jobs.push(...(result.jobs ?? []))
    if ((result.jobs ?? []).length < 100) break
  }
  return resolveExecutedShards({ jobs, runStartedAt: run.run_started_at, expectedTotal })
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(path) : [path]
  })
}

function assertEqualArray(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

export function verifyArtifactClosure({
  root,
  output,
  matrix: matrixInput,
  runId,
  attempt,
  sha,
  executedShards,
}) {
  const matrix = expectedMatrix(matrixInput)
  const currentAttempt = parsePositiveInteger(attempt, "current attempt")
  const expectedNames = Array.from(
    { length: matrix.total },
    (_, index) => `${SHARD_ARTIFACT_PREFIX}-${runId}-${index + 1}`,
  ).sort()
  const actualNames = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort()
  const flatNames = ["blob-report", "e2e-shard-manifest"]
  const flatSingleShard = matrix.total === 1
    && actualNames.length === flatNames.length
    && actualNames.every((name, index) => name === flatNames[index])
  if (!flatSingleShard) {
    assertEqualArray(actualNames, expectedNames, "artifact layout must exactly match matrix shards")
  }

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const manifests = []
  for (let shard = 1; shard <= matrix.total; shard += 1) {
    const artifactDirectory = flatSingleShard
      ? root
      : join(root, `${SHARD_ARTIFACT_PREFIX}-${runId}-${shard}`)
    const files = walkFiles(artifactDirectory)
    const manifestsFound = files.filter((path) => basename(path) === "shard-manifest.json")
    const zips = files.filter((path) => path.endsWith(".zip"))
    if (manifestsFound.length !== 1) throw new Error(`shard ${shard} must contain exactly one manifest`)
    if (zips.length !== 1) throw new Error(`shard ${shard} must contain exactly one blob zip`)
    if (statSync(zips[0]).size === 0) throw new Error(`shard ${shard} blob zip is empty`)

    const manifest = JSON.parse(readFileSync(manifestsFound[0], "utf8"))
    const expected = matrix.shards.get(shard)
    if (manifest.version !== SHARD_MANIFEST_VERSION) throw new Error(`shard ${shard} manifest version mismatch`)
    if (String(manifest.runId) !== String(runId)) throw new Error(`shard ${shard} run ID mismatch`)
    if (manifest.sha !== sha) throw new Error(`shard ${shard} SHA mismatch`)
    if (manifest.shard !== shard || manifest.total !== matrix.total) {
      throw new Error(`shard ${shard} manifest identity mismatch`)
    }
    assertEqualArray(
      (manifest.specs ?? []).map(normalizeSpecPath).sort(),
      expected.specs,
      `shard ${shard} specs mismatch`,
    )
    const manifestAttempt = parsePositiveInteger(manifest.attempt, `shard ${shard} manifest attempt`)
    if (manifestAttempt > currentAttempt) throw new Error(`shard ${shard} manifest is from a future attempt`)
    if (executedShards.has(shard) && manifestAttempt !== currentAttempt) {
      throw new Error(`shard ${shard} executed in attempt ${currentAttempt} but artifact is stale from attempt ${manifestAttempt}`)
    }
    manifests.push(manifest)
    copyFileSync(zips[0], join(output, `shard-${shard}-${basename(zips[0])}`))
  }
  return { manifests, expectedSpecs: matrix.specs }
}

function collectReportFiles(suites, files = []) {
  for (const suite of suites ?? []) {
    if (suite.file) files.push(normalizeSpecPath(suite.file))
    collectReportFiles(suite.suites, files)
  }
  return files
}

export function verifyMergedReport({ report, matrix: matrixInput }) {
  const matrix = expectedMatrix(matrixInput)
  const reportJson = typeof report === "string" ? JSON.parse(report) : report
  const actual = [...new Set(collectReportFiles(reportJson.suites))].sort()
  assertEqualArray(actual, matrix.specs, "merged report spec set mismatch")
  return actual
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const args = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    if (!key?.startsWith("--") || rest[index + 1] == null) throw new Error(`invalid CLI argument ${key}`)
    args[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[index + 1]
  }
  return args
}

export async function runCli(argv, env = process.env) {
  const args = parseArgs(argv)
  if (args.command === "write-manifest") {
    const manifest = createShardManifest({
      runId: args.runId,
      attempt: args.attempt,
      sha: args.sha,
      shard: args.shard,
      total: args.total,
      specs: JSON.parse(env.E2E_SPECS ?? "[]"),
    })
    mkdirSync(resolve(args.output, ".."), { recursive: true })
    writeFileSync(args.output, `${JSON.stringify(manifest, null, 2)}\n`)
    return
  }
  if (args.command === "verify-artifacts") {
    const matrix = env.E2E_MATRIX
    if (!matrix) throw new Error("E2E_MATRIX is required")
    const parsedMatrix = expectedMatrix(matrix)
    const executedShards = await fetchExecutedShards({
      repository: env.GITHUB_REPOSITORY,
      runId: args.runId,
      attempt: args.attempt,
      expectedTotal: parsedMatrix.total,
      token: env.GITHUB_TOKEN,
      apiUrl: env.GITHUB_API_URL,
    })
    verifyArtifactClosure({
      root: args.root,
      output: args.output,
      matrix,
      runId: args.runId,
      attempt: args.attempt,
      sha: args.sha,
      executedShards,
    })
    return
  }
  if (args.command === "verify-merged") {
    const matrix = env.E2E_MATRIX
    if (!matrix) throw new Error("E2E_MATRIX is required")
    verifyMergedReport({ report: readFileSync(args.report, "utf8"), matrix })
    return
  }
  throw new Error(`unknown command ${args.command}`)
}

export function runCliEntry({
  direct = process.argv[1] === fileURLToPath(import.meta.url),
  argv = process.argv.slice(2),
  env = process.env,
  stderr = process.stderr,
  setExitCode = (code) => { process.exitCode = code },
} = {}) {
  if (!direct) return undefined
  return runCli(argv, env).catch((error) => {
    stderr.write(`${error.stack ?? error}\n`)
    setExitCode(1)
  })
}

void runCliEntry()
