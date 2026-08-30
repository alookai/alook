import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, it, expect, vi } from "vitest"
import { readBreakpoint, resolveBreakpoint, useBreakpoint } from "./use-mobile"

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it("reads the current media query synchronously", () => {
    const matchMedia = vi.fn()
      .mockReturnValueOnce({ matches: true })
      .mockReturnValueOnce({ matches: false })
    vi.stubGlobal("window", { matchMedia })

    expect(readBreakpoint()).toBe("mobile")
    expect(readBreakpoint()).toBe("desktop")
    expect(matchMedia).toHaveBeenNthCalledWith(1, "(max-width: 639px)")
    expect(matchMedia).toHaveBeenNthCalledWith(2, "(max-width: 639px)")
  })

  it("stays unknown without a client media-query implementation", () => {
    vi.stubGlobal("window", undefined)
    expect(readBreakpoint()).toBe("unknown")
  })
})
