import { describe, it, expect } from "vitest"
import { resolveBreakpoint } from "./use-breakpoint"

describe("resolveBreakpoint", () => {
  it("returns mobile when the mobile query matches (≤600)", () => {
    expect(resolveBreakpoint({ mobile: true, tablet: false })).toBe("mobile")
  })

  it("returns tablet when only the tablet query matches (601–960)", () => {
    expect(resolveBreakpoint({ mobile: false, tablet: true })).toBe("tablet")
  })

  it("returns desktop when neither matches (≥961)", () => {
    expect(resolveBreakpoint({ mobile: false, tablet: false })).toBe("desktop")
  })

  it("prioritizes mobile over tablet if both somehow match", () => {
    expect(resolveBreakpoint({ mobile: true, tablet: true })).toBe("mobile")
  })
})
