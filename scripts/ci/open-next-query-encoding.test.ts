import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

type Query = Record<string, string | string[]>

const repoRoot = resolve(import.meta.dirname, "../..")
const requireFromWeb = createRequire(resolve(repoRoot, "src/web/package.json"))
const cloudflareEntry = requireFromWeb.resolve("@opennextjs/cloudflare")
const awsDist = resolve(dirname(cloudflareEntry), "../../../aws/dist")

function extractFunction(file: string, name: string, nextMarker?: string) {
  const source = readFileSync(file, "utf8")
  const start = source.indexOf(`export function ${name}`)
  const end = nextMarker ? source.indexOf(nextMarker, start) : source.length
  if (start < 0 || end <= start) throw new Error(`Unable to extract OpenNext function ${name}`)
  return source.slice(start, end).replace(/^export /, "")
}

const httpUtil = resolve(awsDist, "http/util.js")
const routingUtil = resolve(awsDist, "core/routing/util.js")
const converterUtil = resolve(awsDist, "overrides/converters/utils.js")
const iteratorSource = extractFunction(httpUtil, "getQueryFromIterator")
const getQueryFromIterator = Function(`${iteratorSource}; return getQueryFromIterator`)() as (
  entries: Iterable<[string, string]>,
) => Query
const parserSource = extractFunction(converterUtil, "getQueryFromSearchParams")
const getQueryFromSearchParams = Function(
  "getQueryFromIterator",
  `${parserSource}; return getQueryFromSearchParams`,
)(getQueryFromIterator) as (searchParams: URLSearchParams) => Query
const fromQuerySource = extractFunction(routingUtil, "convertFromQueryString", "/**")
const convertFromQueryString = Function(
  "getQueryFromIterator",
  `${fromQuerySource}; return convertFromQueryString`,
)(getQueryFromIterator) as (query: string) => Query
const toQuerySource = extractFunction(
  routingUtil,
  "convertToQueryString",
  "/**\n * Given a raw query string",
)
const convertToQueryString = Function(`${toQuerySource}; return convertToQueryString`)() as (
  query: Query,
) => string

function roundTrip(rawQuery: string, key = "ref") {
  const internalQuery = getQueryFromSearchParams(new URLSearchParams(rawQuery))
  const query = convertToQueryString(internalQuery)
  const url = new URL(`https://example.test/api${query}`)
  return { internalQuery, query, url, value: url.searchParams.get(key) }
}

describe("OpenNext query encoding patch", () => {
  it.each([
    ["%2FGener%239879%2Ffix%2F%231", "/Gener#9879/fix/#1"],
    ["%2F.dm%2FAudrie%234069", "/.dm/Audrie#4069"],
    ["Gener%239879", "Gener#9879"],
    ["%2F%E8%AE%BE%E8%AE%A1+team%2Fa%26b%3Dc%2F%2523literal", "/设计 team/a&b=c/%23literal"],
  ])("round-trips encoded query data %s", (encoded, expected) => {
    const result = roundTrip(`ref=${encoded}`)

    expect(result.value).toBe(expected)
    expect(result.url.hash).toBe("")
    expect(result.query).not.toContain("#")
    expect(result.internalQuery.ref).toBe(encoded)
  })

  it("preserves repeated encoded values and their order", () => {
    const first = "%2Fa%230001%2Fx"
    const second = "%2Fb%230002%2Fy%2F%233"
    const result = roundTrip(`ref=${first}&ref=${second}`)

    expect(result.internalQuery.ref).toEqual([first, second])
    expect(result.url.searchParams.getAll("ref")).toEqual(["/a#0001/x", "/b#0002/y/#3"])
  })

  it("keeps source and rewrite-destination values in one encoded representation", () => {
    const source = getQueryFromSearchParams(
      new URLSearchParams("ref=%2FGener%239879%2Ffix%2F%231"),
    )
    const destination = convertFromQueryString("returnTo=%2Ffoo%3Fa%3D1%26b%3D2")
    const query = convertToQueryString({ ...source, ...destination })
    const url = new URL(`https://example.test/api${query}`)

    expect(query).toContain("returnTo=%2Ffoo%3Fa%3D1%26b%3D2")
    expect(query).not.toContain("%252Ffoo")
    expect(url.searchParams.get("ref")).toBe("/Gener#9879/fix/#1")
    expect(url.searchParams.get("returnTo")).toBe("/foo?a=1&b=2")
  })

  it("returns no suffix for an empty query", () => {
    const result = roundTrip("")

    expect(result.internalQuery).toEqual({})
    expect(result.query).toBe("")
  })
})
