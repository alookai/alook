import { appendFileSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
export const E2E_SPEC_ROOT = "src/web/src/test/e2e-ui"
export const E2E_NATIVE_SHARDS = 24
export const E2E_TARGET_SECONDS = 240
export const PLAYWRIGHT_IMAGE_REPOSITORY = "mcr.microsoft.com/playwright"
const sorted = values => [...new Set(values)].sort()
const normalize = value => value.replaceAll("\\", "/").replace(/^.*src\/test\/e2e-ui\//, "")

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

export function listPlaywrightTests({ root = ROOT, specs = ["all"], shard, execute = execFileSync } = {}) {
  const web = resolve(root, "src/web")
  const require = createRequire(resolve(web, "package.json"))
  const cli = require.resolve("@playwright/test/cli")
  const args = [cli, "test", "--config", resolve(web, "playwright.config.ts"), "--list", "--reporter=json"]
  if (shard) args.push("--shard=" + shard.current + "/" + shard.total, "--pass-with-no-tests")
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

export function discoverE2eSpecs(root = ROOT) {
  return listPlaywrightTests({ root }).files
}

export function validateNativeUiFacts(facts, requested) {
  if (!facts || facts.version !== 1 || !Array.isArray(facts.files) || !facts.files.length
    || !Array.isArray(facts.cases) || !facts.cases.length || !Array.isArray(facts.shards) || !facts.shards.length) {
    throw new Error("native UI discovery is incomplete")
  }
  const selection = sorted(requested.map(normalize))
  if (JSON.stringify(selection) !== JSON.stringify(facts.selection)) throw new Error("native UI selection mismatch")
  if (!selection.includes("all") && JSON.stringify(selection) !== JSON.stringify(facts.files)) throw new Error("selected UI files lack native registrations")
  const keys = sorted(facts.cases.map(test => test.key))
  if (keys.length !== facts.cases.length || JSON.stringify(sorted(facts.cases.map(test => test.file))) !== JSON.stringify(facts.files)) throw new Error("native UI inventory is inconsistent")
  const owned = [], files = []
  for (let index = 0; index < facts.shards.length; index++) {
    const shard = facts.shards[index]
    if (shard.current !== index + 1 || shard.total !== facts.shards.length
      || !Array.isArray(shard.cases) || !Array.isArray(shard.files)) throw new Error("native UI shard identity mismatch")
    const identities = facts.cases.filter(test => shard.cases.includes(test.key))
    if (identities.length !== shard.cases.length || JSON.stringify(sorted(identities.map(test => test.file))) !== JSON.stringify(shard.files)) throw new Error("native UI shard case/file mismatch")
    owned.push(...shard.cases); files.push(...shard.files)
  }
  if (owned.length !== keys.length || JSON.stringify(sorted(owned)) !== JSON.stringify(keys)
    || files.length !== facts.files.length || JSON.stringify(sorted(files)) !== JSON.stringify(facts.files)) throw new Error("native UI partitions are missing or duplicate")
  if (facts.playwright_version !== resolvePlaywrightVersion()) throw new Error("native UI Playwright version mismatch")
  return facts
}

export function queryNativeUiFacts(specs, { root = ROOT, shardCount = E2E_NATIVE_SHARDS, execute } = {}) {
  if (!Array.isArray(specs) || !specs.length || specs.some(spec => typeof spec !== "string")
    || new Set(specs).size !== specs.length || (specs.includes("all") && specs.length !== 1)) throw new Error("invalid UI selection")
  const all = listPlaywrightTests({ root, specs, execute })
  if (!all.files.length) throw new Error("selected UI files have no native registrations")
  const count = Math.min(Number(shardCount), all.files.length)
  if (!Number.isInteger(count) || count < 1) throw new Error("native UI shard count must be positive")
  const shards = []
  for (let current = 1; current <= count; current++) {
    const part = listPlaywrightTests({ root, specs, shard: { current, total: count }, execute })
    shards.push({ current, total: count, files: part.files, cases: part.cases.map(test => test.key) })
  }
  return validateNativeUiFacts({ version: 1, playwright_version: resolvePlaywrightVersion(), selection: sorted(specs.map(normalize)), files: all.files, cases: all.cases, shards }, specs)
}

export function createE2eMatrix(facts, image = resolvePlaywrightImage()) {
  validateNativeUiFacts(facts, facts.selection)
  const active = facts.shards.filter(shard => shard.cases.length)
  return { include: active.map((part, index) => ({
    shard: index + 1, total: active.length, native_shard: part.current, native_total: part.total, image,
    specs: part.files.map(file => "src/test/e2e-ui/" + file), case_keys: part.cases,
  })) }
}

export function runCli(argv, { root = ROOT } = {}) {
  const args = {}
  for (let index = 0; index < argv.length; index += 2) args[argv[index].replace(/^--/, "")] = argv[index + 1]
  const specs = args["specs-json"] ? JSON.parse(args["specs-json"]) : ["all"]
  const facts = queryNativeUiFacts(specs, { root, shardCount: args.shards || E2E_NATIVE_SHARDS })
  const matrix = createE2eMatrix(facts)
  if (args.output) appendFileSync(args.output, "e2e_matrix=" + JSON.stringify(matrix) + "\n")
  else process.stdout.write(JSON.stringify({ facts, matrix }, null, 2) + "\n")
  if (args.summary) appendFileSync(args.summary, `## Native UI shards\n\n${facts.cases.length} registered cases in ${facts.files.length} files; ${matrix.include.length} nonempty native partitions. ${E2E_TARGET_SECONDS}s is a measurement target, not a predicted cutoff.\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli(process.argv.slice(2))
