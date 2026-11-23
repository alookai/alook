import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  E2E_TARGET_SHARDS,
  collectPlaywrightCases,
  computeSpecWeights,
  createE2eMatrix,
  discoverE2eSpecs,
  listPlaywrightTests,
  partitionSpecsLpt,
  queryNativeUiFacts,
  resolvePlaywrightImage,
  resolvePlaywrightVersion,
  runCli,
  validateNativeUiFacts,
} from "./e2e-shards.mjs"
import { createShardManifest, verifyArtifactClosure, verifyMergedReport } from "./e2e-shard-artifacts.mjs"

const root = mkdtempSync(join(tmpdir(), "alook-native-playwright-"))
const web = join(root, "src/web")
const specRoot = join(web, "src/test/e2e-ui")
mkdirSync(specRoot, { recursive: true })
writeFileSync(join(web, "package.json"), '{"type":"module"}')
symlinkSync(resolve("src/web/node_modules"), join(web, "node_modules"), process.platform === "win32" ? "junction" : "dir")
const config = 'export default { testDir: "./src/test/e2e-ui", fullyParallel: false, workers: 1, retries: 0, projects: [{ name: "chromium" }] }'
writeFileSync(join(web, "playwright.config.ts"), config)
writeFileSync(join(specRoot, "a.spec.ts"), 'import { test } from "@playwright/test"; test.describe("owned", () => { for (let i = 0; i < 8; i++) test("case " + i, () => {}) })')
writeFileSync(join(specRoot, "b.spec.ts"), 'import "./imported.journey"')
writeFileSync(join(specRoot, "imported.journey.ts"), 'import { test } from "@playwright/test"; test("imported registration", () => { test.setTimeout(300_000) })')
writeFileSync(join(specRoot, "c.spec.ts"), 'import { test } from "@playwright/test"; test("last", () => { test.slow() })')
writeFileSync(join(specRoot, "d.spec.ts"), 'import { test } from "@playwright/test"; test("tiny", () => {})')
afterAll(() => rmSync(root, { recursive: true, force: true }))

// Cache only successful native command text for identical controlled inputs.
// Each caller still parses and validates it. Source/config edits change the key;
// production callers keep the uncached executor.
const nativeOutput = new Map<string, string>()
const execute = (command: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => {
  const inputs = [join(web, "package.json"), join(web, "playwright.config.ts"),
    ...readdirSync(specRoot).sort().map(file => join(specRoot, file))]
  const hash = createHash("sha256")
  for (const file of inputs) hash.update(file).update("\0").update(readFileSync(file)).update("\0")
  const key = JSON.stringify([command, args, options.cwd, hash.digest("hex")])
  if (!nativeOutput.has(key)) nativeOutput.set(key, execFileSync(command, args, options))
  return nativeOutput.get(key)!
}
const facts = () => queryNativeUiFacts(["all"], { root, shardCount: 3, execute })

describe("locked Playwright image", () => {
  const lockfile = "\n  src/web:\n    devDependencies:\n      '@playwright/test':\n        specifier: ^1.62.1\n        version: 1.62.1\n\n  src/ws-do:\n    dependencies: {}\n"
  it("uses the exact importer, including CRLF", () => {
    expect(resolvePlaywrightVersion(lockfile.replaceAll("\n", "\r\n"))).toBe("1.62.1")
    expect(resolvePlaywrightImage(lockfile)).toBe("mcr.microsoft.com/playwright:v1.62.1-noble")
  })
  it.each(["importers:\n", lockfile.replace("'@playwright/test'", "vitest"), lockfile.replace("version: 1.62.1", "version: latest")])("rejects an unresolved version", source => {
    expect(() => resolvePlaywrightVersion(source)).toThrow()
  })
})

describe("single-pass native discovery and balanced LPT partitioning", { timeout: 60_000 }, () => {
  it("discovers actual registrations in one CLI pass and balances whole files without empty shards", () => {
    expect(discoverE2eSpecs(root, execute)).toEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"])
    const spy = vi.fn(execute)
    const value = queryNativeUiFacts(["all"], { root, shardCount: 3, execute: spy })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(value.version).toBe(2)
    expect(value.cases).toHaveLength(11)
    expect(value.cases).toContainEqual({ file: "b.spec.ts", key: '["b.spec.ts","chromium","imported registration"]' })
    expect(value.cases.filter(test => test.file === "a.spec.ts")).toHaveLength(8)
    // Timeout-budget weights: a=8, b=1 + 0.75*(300/60 - 1)=4, c=1 + 0.75*2=2.5, d=1
    expect(value.weights).toEqual({
      "a.spec.ts": 8,
      "b.spec.ts": 4,
      "c.spec.ts": 2.5,
      "d.spec.ts": 1,
    })
    const matrix = createE2eMatrix(value)
    expect(matrix.include).toHaveLength(3)
    expect(matrix.include.flatMap(part => part.case_keys).sort()).toEqual(value.cases.map(test => test.key).sort())
    expect(matrix.include.flatMap(part => part.specs).sort()).toEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts", "d.spec.ts"].map(file => "src/test/e2e-ui/" + file))
    expect(matrix.include.map(part => part.shard)).toEqual([1, 2, 3])
    expect(matrix.include.map(part => part.total)).toEqual([3, 3, 3])
    // Heavy a.spec.ts (8) is isolated; b (4) and c+d (3.5) fill the other two shards with zero empty shards.
    expect(matrix.include[0]).toMatchObject({ shard: 1, total: 3, weight: 8, specs: ["src/test/e2e-ui/a.spec.ts"] })
    expect(matrix.include[1]).toMatchObject({ shard: 2, total: 3, weight: 4, specs: ["src/test/e2e-ui/b.spec.ts"] })
    expect(matrix.include[2]).toMatchObject({ shard: 3, total: 3, weight: 3.5, specs: ["src/test/e2e-ui/c.spec.ts", "src/test/e2e-ui/d.spec.ts"] })
  })

  it("caps shard count to discovered files and separates heavy timeout files across shards", () => {
    const files = ["heavy-a.spec.ts", "heavy-b.spec.ts", "heavy-c.spec.ts", "light-1.spec.ts", "light-2.spec.ts"]
    const cases = files.map(file => ({ file, key: JSON.stringify([file, "chromium", "case"]) }))
    const weights = { "heavy-a.spec.ts": 20, "heavy-b.spec.ts": 18, "heavy-c.spec.ts": 15, "light-1.spec.ts": 2, "light-2.spec.ts": 2 }
    const shards = partitionSpecsLpt(files, cases, weights, 3)
    expect(shards).toHaveLength(3)
    for (const heavy of ["heavy-a.spec.ts", "heavy-b.spec.ts", "heavy-c.spec.ts"]) {
      const owners = shards.filter(shard => shard.files.includes(heavy))
      expect(owners).toHaveLength(1)
    }
    expect(new Set(shards.flatMap(shard => shard.files.filter(file => file.startsWith("heavy-"))).map(heavy => shards.find(shard => shard.files.includes(heavy))!.current)).size).toBe(3)
    expect(partitionSpecsLpt(files, cases, weights, 20)).toHaveLength(5)
  })

  it("selects one real file and rejects unknown, duplicate or mixed-sentinel selections", () => {
    const value = queryNativeUiFacts(["b.spec.ts"], { root, execute })
    expect(value.files).toEqual(["b.spec.ts"])
    expect(value.cases).toHaveLength(1)
    expect(value.shards).toHaveLength(1)
    for (const specs of [["missing.spec.ts"], ["b.spec.ts", "b.spec.ts"], ["all", "b.spec.ts"], []]) {
      expect(() => queryNativeUiFacts(specs, { root, execute })).toThrow()
    }
  })

  it("rejects native errors, tampered weights, empty shards, and incomplete or duplicate partitions", () => {
    expect(() => collectPlaywrightCases({ suites: [], errors: [{}] })).toThrow("discovery failed")
    expect(() => computeSpecWeights(["missing.spec.ts"], [], root)).toThrow("no discovered cases")
    const value = facts()
    const duplicate = structuredClone(value)
    duplicate.shards[0]!.cases.push(duplicate.shards[0]!.cases[0]!)
    expect(() => validateNativeUiFacts(duplicate, ["all"])).toThrow()
    const missing = structuredClone(value)
    missing.shards[0]!.cases.pop()
    expect(() => validateNativeUiFacts(missing, ["all"])).toThrow()
    const badWeight = structuredClone(value)
    badWeight.shards[0]!.weight = 999
    expect(() => validateNativeUiFacts(badWeight, ["all"])).toThrow("weight mismatch")
    const emptyShard = structuredClone(value)
    emptyShard.shards.push({ current: 4, total: 4, weight: 0, files: [], cases: [] })
    for (const shard of emptyShard.shards) shard.total = 4
    expect(() => validateNativeUiFacts(emptyShard, ["all"])).toThrow("identity mismatch")
    expect(() => validateNativeUiFacts(value, ["b.spec.ts"])).toThrow("selection mismatch")
    expect(() => validateNativeUiFacts({ ...value, playwright_version: "0.0.0" }, ["all"])).toThrow("version mismatch")
  })

  it("refreshes native observations when execution constraints or imported registrations change", () => {
    const journey = join(specRoot, "imported.journey.ts")
    const original = readFileSync(journey, "utf8")
    try {
      writeFileSync(join(web, "playwright.config.ts"), config.replace("fullyParallel: false", "fullyParallel: true"))
      expect(() => queryNativeUiFacts(["all"], { root, execute })).toThrow("constraints changed")
      writeFileSync(join(web, "playwright.config.ts"), config)
      writeFileSync(journey, original + '; test("new imported registration", () => {})')
      const changed = listPlaywrightTests({ root, execute })
      expect(changed.cases).toHaveLength(12)
      expect(changed.cases.filter(test => test.file === "b.spec.ts")).toHaveLength(2)
      expect(changed.cases).toContainEqual({ file: "b.spec.ts", key: '["b.spec.ts","chromium","new imported registration"]' })
    } finally {
      writeFileSync(join(web, "playwright.config.ts"), config)
      writeFileSync(journey, original)
    }
    expect(listPlaywrightTests({ root, execute }).cases).toHaveLength(11)
  })

  it("merges blob reports produced by explicit per-shard file execution with exact case closure", { timeout: 60_000 }, () => {
    const work = mkdtempSync(join(tmpdir(), "alook-explicit-blob-merge-"))
    try {
      const workWeb = join(work, "src/web")
      const workSpecs = join(workWeb, "src/test/e2e-ui")
      mkdirSync(workSpecs, { recursive: true })
      writeFileSync(join(workWeb, "package.json"), '{"type":"module"}')
      symlinkSync(resolve("src/web/node_modules"), join(workWeb, "node_modules"), process.platform === "win32" ? "junction" : "dir")
      writeFileSync(join(workWeb, "playwright.config.ts"),
        'export default { testDir: "./src/test/e2e-ui", fullyParallel: false, workers: 1, retries: 0, reporter: [["blob"]], projects: [{ name: "chromium" }] }')
      writeFileSync(join(workSpecs, "one.spec.ts"), 'import { test, expect } from "@playwright/test"; test("first", () => { expect(1).toBe(1) })')
      writeFileSync(join(workSpecs, "two.spec.ts"), 'import { test, expect } from "@playwright/test"; test("second", () => { expect(2).toBe(2) })')

      const uiFacts = queryNativeUiFacts(["all"], { root: work, shardCount: 2 })
      const matrix = createE2eMatrix(uiFacts)
      expect(matrix.include).toHaveLength(2)

      const downloaded = join(work, "downloaded")
      const cli = resolve("src/web/node_modules/@playwright/test/cli.js")
      for (const entry of matrix.include) {
        const artifactDir = join(downloaded, `blob-report-run-9-${entry.shard}`)
        const blobDir = join(artifactDir, "blob-report")
        const manifestDir = join(artifactDir, "e2e-shard-manifest")
        mkdirSync(blobDir, { recursive: true })
        mkdirSync(manifestDir, { recursive: true })
        execFileSync(process.execPath, [cli, "test", "--config", join(workWeb, "playwright.config.ts"), ...entry.specs], {
          cwd: workWeb,
          stdio: "pipe",
          env: { ...process.env, PLAYWRIGHT_BLOB_OUTPUT_DIR: blobDir },
        })
        writeFileSync(join(manifestDir, "shard-manifest.json"), JSON.stringify(createShardManifest({
          runId: "run-9",
          attempt: 1,
          sha: "a".repeat(40),
          shard: entry.shard,
          total: entry.total,
          specs: entry.specs,
          caseKeys: entry.case_keys,
        })))
      }

      const verifiedBlobs = join(work, "verified-blobs")
      verifyArtifactClosure({
        root: downloaded,
        output: verifiedBlobs,
        matrix,
        runId: "run-9",
        attempt: 1,
        sha: "a".repeat(40),
        executedShards: new Set([1, 2]),
      })
      const mergedJson = join(work, "merged-report.json")
      execFileSync(process.execPath, [cli, "merge-reports", "--reporter", "json", verifiedBlobs], {
        cwd: workWeb,
        stdio: "pipe",
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: mergedJson },
      })
      expect(verifyMergedReport({ report: readFileSync(mergedJson, "utf8"), matrix })).toEqual(["one.spec.ts", "two.spec.ts"])
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("balances the live repository inventory into 20 non-empty shards and separates known heavy specs", { timeout: 60_000 }, () => {
    const live = queryNativeUiFacts(["all"])
    expect(live.shards).toHaveLength(E2E_TARGET_SHARDS)
    expect(live.shards.every(shard => shard.files.length > 0 && shard.cases.length > 0)).toBe(true)
    const heavySpecs = [
      "25-community-cache-first-warm-reload.spec.ts",
      "51-share-image-assets.spec.ts",
      "55-history-reading-continuity.spec.ts",
      "51-mobile-forum-tag-editor.spec.ts",
    ].filter(file => live.files.includes(file))
    const heavyShardIds = heavySpecs.map(file => live.shards.find(shard => shard.files.includes(file))!.current)
    expect(new Set(heavyShardIds).size).toBe(heavySpecs.length)
  })
})

describe("balanced shard CLI", { timeout: 60_000 }, () => {
  it("writes balanced matrix and a target without prediction claims", () => {
    const output = join(root, "output"), summary = join(root, "summary.md")
    runCli(["--specs-json", '["b.spec.ts"]', "--output", output, "--summary", summary], { root, execute })
    expect(JSON.parse(readFileSync(output, "utf8").trim().slice("e2e_matrix=".length)).include[0]).toMatchObject({ shard: 1, total: 1, weight: 4, specs: ["src/test/e2e-ui/b.spec.ts"] })
    expect(readFileSync(summary, "utf8")).toContain("not a predicted cutoff")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      runCli(["--shards", "1"], { root, execute })
      expect(JSON.parse(String(stdout.mock.calls[0]![0])).facts.cases).toHaveLength(11)
    } finally { stdout.mockRestore() }
  })
})
