import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { scanDynamicBindSites } from "./d1-dynamic-bind-contract"

type Strategy = "fixed-literal" | "exact-chunk" | "json-set" | "subquery" | "bounded-public-input"
interface ManifestEntry {
  key: string
  strategy: Strategy
  fixedParams?: number
  maxExport?: string
}

const root = resolve(import.meta.dirname, "../..")
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/d1-dynamic-bind-sites.json"), "utf8"),
) as ManifestEntry[]

describe("D1 dynamic bind strategy contract", () => {
  it("requires every source site to have one reviewed strategy", () => {
    const sites = scanDynamicBindSites(root)
    const actual = sites.map((site) => site.key)
    const expected = manifest.map((entry) => entry.key).sort()
    expect(new Set(expected).size).toBe(expected.length)
    expect(actual).toEqual(expected)
    const expectedSites = new Map(sites.map((site) => [site.key, site]))
    for (const entry of manifest) {
      const site = expectedSites.get(entry.key)
      expect(entry.strategy).toBe(site?.strategyHint)
      expect(entry.fixedParams).toBe(site?.fixedParamsHint)
    }
  })

  it("requires strategy-specific bind budgets", () => {
    const exportedLimits = [
      "src/shared/src/constants.ts",
      "src/shared/src/schemas.ts",
      "src/shared/src/index.ts",
    ].map((file) => readFileSync(resolve(root, file), "utf8")).join("\n")

    for (const entry of manifest) {
      if (entry.strategy === "exact-chunk") {
        expect(entry.fixedParams, `${entry.key} needs fixedParams`).toBeTypeOf("number")
        expect(entry.fixedParams!, `${entry.key} has an invalid fixed-bind budget`).toBeGreaterThanOrEqual(0)
        expect(entry.fixedParams!, `${entry.key} has an invalid fixed-bind budget`).toBeLessThan(100)
      }
      if (entry.strategy === "bounded-public-input") {
        expect(entry.maxExport, `${entry.key} needs maxExport`).toMatch(/^[A-Z][A-Z0-9_]+$/)
        expect(exportedLimits).toMatch(new RegExp(`export const ${entry.maxExport}\\b`))
      }
    }
  })

  it("detects an unreviewed dynamic bind site", () => {
    const fixture = scanDynamicBindSites(root, {
      file: "fixture.ts",
      source: "export function naked(db: any, ids: string[]) { return db.select().where(inArray(table.id, ids)); }",
    })
    expect(fixture.map((site) => site.key)).toEqual(["fixture.ts:naked:inArray:1"])
    expect(manifest.some((entry) => entry.key === fixture[0]?.key)).toBe(false)
  })
})
