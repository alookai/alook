import { appendFileSync, readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const E2E_SPEC_ROOT = "src/web/src/test/e2e-ui"
export const E2E_TARGET_SHARDS = 14
export const E2E_TARGET_SECONDS = 240
export const E2E_DEFAULT_CASE_TIMEOUT_MS = 60_000
export const E2E_TIMEOUT_WEIGHT_FACTOR = 0.75
export const PLAYWRIGHT_IMAGE_REPOSITORY = "mcr.microsoft.com/playwright"
const sorted = values => [...new Set(values)].sort()
const normalize = value => value.replaceAll("\\", "/").replace(/^.*src\/test\/e2e-ui\//, "")
const roundWeight = value => Math.round(value * 100) / 100

export function resolvePlaywrightVersion(lockfile = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8")) {
  const text = lockfile.replaceAll("\r\n", "\n")
  const start = text.indexOf("\n  src/web:\n")
  if (start < 0) throw new Error("pnpm lockfile is missing the src/web importer")
  const body = text.slice(start + 1)
  const end = body.slice(1).search(/\n  \S[^\n]*:\n/)
  const importer = end < 0 ? body : body.slice(0, end + 1)
  const version = importer.match(/\n      '@playwright\/test':\n(?:        [^\n]*\n)*?        version: ([^\s(]+)/)?.[1]
  if (!version) throw new Error("src/web importer is missing an exact @playwright/test version")
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid @playwright/test version: " + version)
  return version
}

export function resolvePlaywrightImage(lockfile) {
  return `${PLAYWRIGHT_IMAGE_REPOSITORY}:v${resolvePlaywrightVersion(lockfile)}-noble`
}

export function collectPlaywrightCases(report) {
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || report.errors.length) {
    throw new Error("native Playwright discovery failed")
  }
  const cases = []
  const visit = (suite, owner, parents) => {
    for (const spec of suite.specs || []) {
      if (!Array.isArray(spec.tests) || !spec.tests.length) throw new Error("native Playwright spec has no projects")
      for (const test of spec.tests) {
        const project = test.projectName || test.projectId
        if (typeof project !== "string" || typeof spec.title !== "string") throw new Error("invalid native Playwright case identity")
        cases.push({ key: JSON.stringify([owner, project, ...parents, spec.title]), file: owner })
      }
    }
    for (const child of suite.suites || []) visit(child, owner, [...parents, child.title])
  }
  for (const suite of report.suites) {
    const file = normalize(suite.file || "")
    if (!file.endsWith(".spec.ts") || file.startsWith("/") || file.split("/").includes("..")) throw new Error("invalid native Playwright file")
    visit(suite, file, [])
  }
  if (new Set(cases.map(test => test.key)).size !== cases.length) throw new Error("duplicate native Playwright case")
  return cases.sort((left, right) => left.key.localeCompare(right.key))
}

export function listPlaywrightTests({ root = ROOT, specs = ["all"], execute = execFileSync } = {}) {
  const web = resolve(root, "src/web")
  const require = createRequire(resolve(web, "package.json"))
  const cli = require.resolve("@playwright/test/cli")
  const args = [cli, "test", "--config", resolve(web, "playwright.config.ts"), "--list", "--reporter=json"]
  if (!(specs.length === 1 && specs[0] === "all")) args.push(...specs.map(spec => "src/test/e2e-ui/" + normalize(spec)))
  const text = execute(process.execPath, args, {
    cwd: web, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: "", PLAYWRIGHT_JSON_OUTPUT_DIR: "" },
  })
  const report = JSON.parse(text)
  if (report.config?.fullyParallel !== false || report.config?.workers !== 1
    || report.config?.projects?.some(project => project.retries !== 0)) throw new Error("native browser execution constraints changed")
  const cases = collectPlaywrightCases(report)
  return { files: sorted(cases.map(test => test.file)), cases }
}

export function discoverE2eSpecs(root = ROOT, execute) {
  return listPlaywrightTests({ root, execute }).files
}

function collectSpecSource(specFile, root) {
  const specRoot = resolve(root, E2E_SPEC_ROOT)
  const entry = resolve(specRoot, normalize(specFile))
  if (!statSync(entry, { throwIfNoEntry: false })?.isFile()) return ""
  const seen = new Set([entry])
  const queue = [entry]
  const chunks = []
  while (queue.length) {
    const file = queue.pop()
    const source = readFileSync(file, "utf8")
    chunks.push(source)
    const dir = dirname(file)
    for (const match of source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)) {
      const specifier = match[1]
      for (const candidate of [specifier, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}.mjs`]) {
        const target = resolve(dir, candidate)
        const rel = relative(specRoot, target).replaceAll("\\", "/")
        if (!rel || rel.startsWith("..") || rel.startsWith("_setup/") || rel.startsWith("_fixtures/")
          || rel.includes("/_setup/") || rel.includes("/_fixtures/")) continue
        if (!seen.has(target) && statSync(target, { throwIfNoEntry: false })?.isFile()) {
          seen.add(target)
          queue.push(target)
          break
        }
      }
    }
  }
  return chunks.join("\n")
}

export function computeSpecWeights(files, cases, root = ROOT) {
  const counts = new Map()
  for (const test of cases) counts.set(test.file, (counts.get(test.file) || 0) + 1)
  const weights = {}
  for (const file of sorted(files.map(normalize))) {
    const count = counts.get(file) || 0
    if (count < 1) throw new Error(`spec ${file} has no discovered cases`)
    const source = collectSpecSource(file, root)
    let extraTimeoutUnits = 0
    for (const match of source.matchAll(/\btest\.setTimeout\(\s*([\d_]+)\s*\)/g)) {
      const ms = Number(match[1].replaceAll("_", ""))
      if (Number.isFinite(ms) && ms > E2E_DEFAULT_CASE_TIMEOUT_MS) {
        extraTimeoutUnits += ms / E2E_DEFAULT_CASE_TIMEOUT_MS - 1
      }
    }
    for (const _ of source.matchAll(/\btest\.slow\(\s*\)/g)) {
      extraTimeoutUnits += 2
    }
    weights[file] = roundWeight(count + E2E_TIMEOUT_WEIGHT_FACTOR * extraTimeoutUnits)
  }
  return weights
}

export function partitionSpecsLpt(files, cases, weights, shardCount = E2E_TARGET_SHARDS) {
  const uniqueFiles = sorted(files.map(normalize))
  if (!uniqueFiles.length) throw new Error("cannot partition an empty spec set")
  const requested = Number(shardCount)
  if (!Number.isInteger(requested) || requested < 1) throw new Error("UI shard count must be positive")
  const count = Math.min(requested, uniqueFiles.length)
  const casesByFile = new Map()
  for (const test of cases) {
    const list = casesByFile.get(test.file) || []
    list.push(test.key)
    casesByFile.set(test.file, list)
  }
  const ranked = [...uniqueFiles].sort((left, right) => (
    (weights[right] - weights[left]) || left.localeCompare(right)
  ))
  const bins = Array.from({ length: count }, () => ({ files: [], cases: [], weight: 0 }))
  for (const file of ranked) {
    const fileWeight = weights[file]
    if (typeof fileWeight !== "number" || !Number.isFinite(fileWeight) || fileWeight <= 0) {
      throw new Error(`invalid weight for spec ${file}`)
    }
    let bestIndex = 0
    for (let index = 1; index < bins.length; index++) {
      const best = bins[bestIndex]
      const candidate = bins[index]
      if (candidate.weight < best.weight
        || (candidate.weight === best.weight && candidate.files.length < best.files.length)) {
        bestIndex = index
      }
    }
    const target = bins[bestIndex]
    target.files.push(file)
    target.cases.push(...(casesByFile.get(file) || []))
    target.weight = roundWeight(target.weight + fileWeight)
  }
  for (const bin of bins) {
    bin.files.sort()
    bin.cases.sort()
  }
  bins.sort((left, right) => (
    (right.weight - left.weight) || left.files[0].localeCompare(right.files[0])
  ))
  return bins.map((bin, index) => ({
    current: index + 1,
    total: bins.length,
    weight: bin.weight,
    files: bin.files,
    cases: bin.cases,
  }))
}

export function validateNativeUiFacts(facts, requested) {
  if (!facts || facts.version !== 2 || !Array.isArray(facts.files) || !facts.files.length
    || !Array.isArray(facts.cases) || !facts.cases.length || !Array.isArray(facts.shards) || !facts.shards.length
    || !facts.weights || typeof facts.weights !== "object") {
    throw new Error("native UI discovery is incomplete")
  }
  const selection = sorted(requested.map(normalize))
  if (JSON.stringify(selection) !== JSON.stringify(facts.selection)) throw new Error("native UI selection mismatch")
  if (!selection.includes("all") && JSON.stringify(selection) !== JSON.stringify(facts.files)) throw new Error("selected UI files lack native registrations")
  const keys = sorted(facts.cases.map(test => test.key))
  if (keys.length !== facts.cases.length || JSON.stringify(sorted(facts.cases.map(test => test.file))) !== JSON.stringify(facts.files)) throw new Error("native UI inventory is inconsistent")
  if (JSON.stringify(Object.keys(facts.weights).sort()) !== JSON.stringify(facts.files)) throw new Error("native UI weight keys mismatch")
  for (const file of facts.files) {
    const value = facts.weights[file]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`invalid weight for ${file}`)
  }
  const owned = [], files = []
  for (let index = 0; index < facts.shards.length; index++) {
    const shard = facts.shards[index]
    if (shard.current !== index + 1 || shard.total !== facts.shards.length
      || !Array.isArray(shard.cases) || !shard.cases.length
      || !Array.isArray(shard.files) || !shard.files.length) throw new Error("native UI shard identity mismatch")
    const identities = facts.cases.filter(test => shard.cases.includes(test.key))
    if (identities.length !== shard.cases.length || JSON.stringify(sorted(identities.map(test => test.file))) !== JSON.stringify(shard.files)) throw new Error("native UI shard case/file mismatch")
    const expectedWeight = roundWeight(shard.files.reduce((sum, file) => sum + facts.weights[file], 0))
    if (shard.weight !== expectedWeight) throw new Error("native UI shard weight mismatch")
    owned.push(...shard.cases); files.push(...shard.files)
  }
  if (owned.length !== keys.length || JSON.stringify(sorted(owned)) !== JSON.stringify(keys)
    || files.length !== facts.files.length || JSON.stringify(sorted(files)) !== JSON.stringify(facts.files)) throw new Error("native UI partitions are missing or duplicate")
  if (facts.playwright_version !== resolvePlaywrightVersion()) throw new Error("native UI Playwright version mismatch")
  return facts
}

export function queryNativeUiFacts(specs, { root = ROOT, shardCount = E2E_TARGET_SHARDS, execute } = {}) {
  if (!Array.isArray(specs) || !specs.length || specs.some(spec => typeof spec !== "string")
    || new Set(specs).size !== specs.length || (specs.includes("all") && specs.length !== 1)) throw new Error("invalid UI selection")
  const all = listPlaywrightTests({ root, specs, execute })
  if (!all.files.length) throw new Error("selected UI files have no native registrations")
  const weights = computeSpecWeights(all.files, all.cases, root)
  const shards = partitionSpecsLpt(all.files, all.cases, weights, shardCount)
  return validateNativeUiFacts({
    version: 2,
    playwright_version: resolvePlaywrightVersion(),
    selection: sorted(specs.map(normalize)),
    files: all.files,
    cases: all.cases,
    weights,
    shards,
  }, specs)
}

export function createE2eMatrix(facts, image = resolvePlaywrightImage()) {
  validateNativeUiFacts(facts, facts.selection)
  return { include: facts.shards.map(part => ({
    shard: part.current,
    total: part.total,
    weight: part.weight,
    image,
    specs: part.files.map(file => "src/test/e2e-ui/" + file),
    case_keys: part.cases,
  })) }
}

export function runCli(argv, { root = ROOT, execute } = {}) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) args[argv[index].replace(/^--/, "")] = argv[index + 1]
  const specs = args["specs-json"] ? JSON.parse(args["specs-json"]) : ["all"]
  const facts = queryNativeUiFacts(specs, { root, shardCount: args.shards || E2E_TARGET_SHARDS, execute })
  const matrix = createE2eMatrix(facts)
  const minWeight = Math.min(...matrix.include.map(part => part.weight))
  const maxWeight = Math.max(...matrix.include.map(part => part.weight))
  if (args.output) appendFileSync(args.output, "e2e_matrix=" + JSON.stringify(matrix) + "\n")
  else process.stdout.write(JSON.stringify({ facts, matrix }, null, 2) + "\n")
  if (args.summary) appendFileSync(args.summary, `## Balanced UI shards\n\n${facts.cases.length} registered cases in ${facts.files.length} files; ${matrix.include.length} balanced partitions (weight ${minWeight}–${maxWeight}). ${E2E_TARGET_SECONDS}s is a measurement target, not a predicted cutoff.\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2))
