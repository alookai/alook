import { describe, expect, it } from "vitest"
import { ssrGeometryErrors, type SsrLifecycleSample } from "./e2e-ui/_fixtures/community-ssr-geometry"

const rect = (width: number) => ({ x: 0, y: 0, width, height: 900 })
const sample = (overrides: Partial<SsrLifecycleSample> = {}): SsrLifecycleSample => ({
  timestamp: 100,
  phase: "ssr",
  readyState: "interactive",
  shellChildCount: 3,
  overflow: 0,
  geometry: { shell: rect(390), main: rect(390), surface: rect(390) },
  ...overrides,
})

describe("SSR lifecycle geometry boundary", () => {
  it("retains a parsing prefix and validates the complete pre-JS and hydrated document", () => {
    const samples = [
      sample({ phase: "parsing", readyState: "loading", shellChildCount: 0, geometry: { shell: rect(390) } }),
      sample(),
      sample({ phase: "hydrating" }),
    ]
    expect(ssrGeometryErrors(samples, 390, "detail")).toEqual([])
    expect(samples).toHaveLength(3)
  })

  it.each(["ssr", "hydrating"] as const)("rejects missing modules in a %s sample even when later frames recover", (phase) => {
    const errors = ssrGeometryErrors([
      sample(),
      sample({ phase, geometry: { shell: rect(390) } }),
      sample({ phase: "hydrating" }),
    ], 390, "detail")
    expect(errors).toContain(`sample 1 (${phase}): incomplete modules shell`)
  })

  it("rejects a parsed frame where the entire shell disappears", () => {
    expect(ssrGeometryErrors([
      sample(), sample({ geometry: {} }), sample(),
    ], 390, "detail")).toContain("sample 1 (ssr): incomplete modules ")
  })

  it("rejects desktop width and overflow during parsing", () => {
    const errors = ssrGeometryErrors([
      sample({ phase: "parsing", overflow: 250, geometry: { shell: rect(640) } }),
      sample(),
    ], 390, "detail")
    expect(errors).toContain("sample 0 (parsing): horizontal overflow 250")
    expect(errors).toContain("sample 0 (parsing): shell width 640, expected 390")
  })

  it("validates every present list module during parsing and requires all modules after parsing", () => {
    const geometry = { shell: rect(390), rail: rect(56), sidebar: rect(333), surface: rect(334), userBar: rect(390) }
    expect(ssrGeometryErrors([
      sample({ phase: "parsing", geometry: { shell: rect(390), rail: rect(56) } }),
      sample({ geometry }),
    ], 390, "list")).toEqual([])
    expect(ssrGeometryErrors([
      sample({ phase: "parsing", geometry: { userBar: rect(640) } }),
      sample({ geometry: { shell: rect(390) } }),
      sample({ geometry }),
    ], 390, "list")).toEqual([
      "sample 0 (parsing): userBar width 640, expected 390",
      "sample 1 (ssr): incomplete modules shell",
    ])
  })

  it("rejects an empty recording", () => {
    expect(ssrGeometryErrors([], 390, "detail")).toEqual([
      "no lifecycle samples", "no complete parsed-document sample",
    ])
  })

  it("cannot pass with only parsing samples", () => {
    expect(ssrGeometryErrors([sample({ phase: "parsing" })], 390, "detail"))
      .toContain("no complete parsed-document sample")
  })

  it("rejects extra desktop modules and later geometry drift", () => {
    expect(ssrGeometryErrors([
      sample({ phase: "parsing", geometry: { shell: rect(390), sidebar: rect(240) } }),
      sample(),
      sample({ phase: "hydrating", geometry: { shell: rect(390), main: { ...rect(390), y: 22 }, surface: rect(390) } }),
    ], 390, "detail")).toEqual([
      "sample 0 (parsing): unexpected module sidebar",
      "sample 2 (hydrating): main.y drift",
    ])
  })
})
