import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect } from "vitest"
import { resolveBreakpoint, useBreakpoint } from "./use-mobile"

describe("resolveBreakpoint", () => {
  it("starts unknown before client media-query hydration", () => {
    function Probe() {
      return createElement("div", { "data-breakpoint": useBreakpoint() })
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain(
      'data-breakpoint="unknown"',
    )
  })

  it("returns mobile when the mobile query matches (<640)", () => {
    expect(resolveBreakpoint({ mobile: true })).toBe("mobile")
  })

  it("returns desktop when the mobile query does not match (≥640)", () => {
    expect(resolveBreakpoint({ mobile: false })).toBe("desktop")
  })
})
