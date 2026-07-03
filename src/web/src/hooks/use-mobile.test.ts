import { describe, it, expect } from "vitest"
import { resolveBreakpoint } from "./use-mobile"

describe("resolveBreakpoint", () => {
  it("returns mobile when the mobile query matches (<640)", () => {
    expect(resolveBreakpoint({ mobile: true })).toBe("mobile")
  })

  it("returns desktop when the mobile query does not match (≥640)", () => {
    expect(resolveBreakpoint({ mobile: false })).toBe("desktop")
  })
})
