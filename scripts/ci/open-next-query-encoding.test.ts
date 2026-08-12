import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../..")
const requireFromWeb = createRequire(resolve(repoRoot, "src/web/package.json"))
const cloudflareEntry = requireFromWeb.resolve("@opennextjs/cloudflare")
const awsUtil = resolve(dirname(cloudflareEntry), "../../../aws/dist/core/routing/util.js")
const source = readFileSync(awsUtil, "utf8")
const start = source.indexOf("export function convertToQueryString")
const end = source.indexOf("/**\n * Given a raw query string", start)
const functionSource = source.slice(start, end).replace(/^export /, "")
const convertToQueryString = Function(`${functionSource}; return convertToQueryString`)() as (
  query: Record<string, string | string[]>,
) => string

function roundTrip(value: string) {
  const query = convertToQueryString({ ref: value })
  const url = new URL(`https://example.test/api${query}`)
  return { query, url, value: url.searchParams.get("ref") }
}

describe("OpenNext query encoding patch", () => {
  it.each([
    "/Gener#9879/fix/#1",
    "/.dm/Audrie#4069",
    "Gener#9879",
    "/设计 team/a&b=c/%23literal",
  ])("round-trips %s as query data", (input) => {
    const result = roundTrip(input)

    expect(result.value).toBe(input)
    expect(result.url.hash).toBe("")
    expect(result.query).not.toContain("#")
  })

  it("preserves repeated values and their order", () => {
    const query = convertToQueryString({ ref: ["/a#0001/x", "/b#0002/y/#3"] })
    const values = new URL(`https://example.test/api${query}`).searchParams.getAll("ref")

    expect(values).toEqual(["/a#0001/x", "/b#0002/y/#3"])
  })

  it("returns no suffix for an empty query", () => {
    expect(convertToQueryString({})).toBe("")
  })
})
