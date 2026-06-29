import { describe, it, expect } from "vitest"
import { resolveBreakpoint } from "./use-breakpoint"

describe("resolveBreakpoint", () => {
  it("returns mobile when the mobile query matches (≤600)", () => {
    expect(resolveBreakpoint({ mobile: true })).toBe("mobile")
  })

  it("returns desktop when the mobile query does not match (≥601)", () => {
    expect(resolveBreakpoint({ mobile: false })).toBe("desktop")
  })
})
