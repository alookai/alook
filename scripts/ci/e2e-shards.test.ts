import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  collectPlaywrightCases,
  createE2eMatrix,
  discoverE2eSpecs,
  queryNativeUiFacts,
  resolvePlaywrightImage,
  resolvePlaywrightVersion,
  runCli,
  validateNativeUiFacts,
} from "./e2e-shards.mjs"

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
writeFileSync(join(specRoot, "imported.journey.ts"), 'import { test } from "@playwright/test"; test("imported registration", () => {})')
writeFileSync(join(specRoot, "c.spec.ts"), 'import { test } from "@playwright/test"; test("last", () => {})')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const facts = () => queryNativeUiFacts(["all"], { root, shardCount: 3 })

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

describe("native discovery and partition closure", () => {
  it("discovers actual registrations, including an imported journey owned by its spec", () => {
    expect(discoverE2eSpecs(root)).toEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts"])
    const value = facts()
    expect(value.cases).toHaveLength(10)
    expect(value.cases).toContainEqual({ file: "b.spec.ts", key: '["b.spec.ts","chromium","imported registration"]' })
    expect(value.cases.filter(test => test.file === "a.spec.ts")).toHaveLength(8)
    const matrix = createE2eMatrix(value)
    expect(matrix.include.flatMap(part => part.case_keys).sort()).toEqual(value.cases.map(test => test.key).sort())
    expect(matrix.include.flatMap(part => part.specs).sort()).toEqual(["a.spec.ts", "b.spec.ts", "c.spec.ts"].map(file => "src/test/e2e-ui/" + file))
    expect(matrix.include.map(part => part.shard)).toEqual(matrix.include.map((_, index) => index + 1))
    for (const part of matrix.include) {
      expect(part.native_total).toBe(3)
      expect(part.case_keys).toEqual(value.shards[part.native_shard - 1]!.cases)
    }
    expect(matrix.include.length).toBeLessThan(3)
  })

  it("selects one real file and rejects unknown, duplicate or mixed-sentinel selections", () => {
    const value = queryNativeUiFacts(["b.spec.ts"], { root })
    expect(value.files).toEqual(["b.spec.ts"])
    expect(value.cases).toHaveLength(1)
    for (const specs of [["missing.spec.ts"], ["b.spec.ts", "b.spec.ts"], ["all", "b.spec.ts"], []]) {
      expect(() => queryNativeUiFacts(specs, { root })).toThrow()
    }
  })

  it("rejects native errors and incomplete or duplicate partitions", () => {
    expect(() => collectPlaywrightCases({ suites: [], errors: [{}] })).toThrow("discovery failed")
    const value = facts()
    const duplicate = structuredClone(value)
    duplicate.shards[0]!.cases.push(duplicate.shards[0]!.cases[0]!)
    expect(() => validateNativeUiFacts(duplicate, ["all"])).toThrow()
    const missing = structuredClone(value)
    missing.shards[0]!.cases.pop()
    expect(() => validateNativeUiFacts(missing, ["all"])).toThrow()
    expect(() => validateNativeUiFacts(value, ["b.spec.ts"])).toThrow("selection mismatch")
    expect(() => validateNativeUiFacts({ ...value, playwright_version: "0.0.0" }, ["all"])).toThrow("version mismatch")
  })

  it("fails discovery when native execution constraints change", () => {
    try {
      writeFileSync(join(web, "playwright.config.ts"), config.replace("fullyParallel: false", "fullyParallel: true"))
      expect(() => queryNativeUiFacts(["all"], { root })).toThrow("constraints changed")
    } finally {
      writeFileSync(join(web, "playwright.config.ts"), config)
    }
  })
})

describe("native shard CLI", () => {
  it("writes native matrix and a target without prediction claims", () => {
    const output = join(root, "output"), summary = join(root, "summary.md")
    runCli(["--specs-json", '["b.spec.ts"]', "--output", output, "--summary", summary], { root })
    expect(JSON.parse(readFileSync(output, "utf8").trim().slice("e2e_matrix=".length)).include[0]).toMatchObject({ native_shard: 1, native_total: 1, specs: ["src/test/e2e-ui/b.spec.ts"] })
    expect(readFileSync(summary, "utf8")).toContain("not a predicted cutoff")
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      runCli(["--shards", "1"], { root })
      expect(JSON.parse(String(stdout.mock.calls[0]![0])).facts.cases).toHaveLength(10)
    } finally { stdout.mockRestore() }
  })
})
