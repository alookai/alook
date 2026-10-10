import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { scanDynamicBindSites } from "./d1-dynamic-bind-contract"

interface ManifestEntry {
  key: string
}

const root = resolve(import.meta.dirname, "../..")
const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/d1-dynamic-bind-sites.json"), "utf8"),
) as ManifestEntry[]

describe("D1 dynamic bind site inventory", () => {
  it("requires every source site to have one reviewed inventory entry", () => {
    const sites = scanDynamicBindSites(root)
    const actual = sites.map((site) => site.key)
    const expected = manifest.map((entry) => entry.key).sort()
    expect(new Set(expected).size).toBe(expected.length)
    expect(actual).toEqual(expected)
  })

  it("does not certify an unbounded array with an invented strategy or budget", () => {
    const [site] = scanDynamicBindSites(root, {
      file: "fixture.ts",
      source: "export function naked(db: any, ids: string[]) { return db.select().where(inArray(table.id, ids)); }",
    })
    expect(site).not.toHaveProperty("strategyHint")
    expect(site).not.toHaveProperty("fixedParamsHint")
    expect(Object.keys(site!).sort()).toEqual(["file", "functionName", "key", "operator"])
    expect(manifest.every((entry) => Object.keys(entry).length === 1)).toBe(true)
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
