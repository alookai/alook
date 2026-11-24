import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LANDING_PROVIDERS } from "./landing-content"
import { LandingHeroBackendBadge } from "./landing-hero-backend-badge"

let inView: IntersectionObserverCallback

function setVisible(visible: boolean) {
  const entry = { isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry
  act(() => inView([entry], {} as IntersectionObserver))
}

function advance() {
  act(() => vi.advanceTimersByTime(3000))
}

function currentBackend() {
  return screen.getByTestId("landing-hero-backend").querySelector("[data-backend-current]")
}

describe("landing hero backend badge", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, "hidden", "get").mockReturnValue(false)
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { inView = callback }
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("rotates through the public provider list with branded icons and wraps", () => {
    render(<LandingHeroBackendBadge />)
    setVisible(true)
    const badge = screen.getByTestId("landing-hero-backend")
    for (const { id, label } of LANDING_PROVIDERS) {
      expect(badge).toHaveAttribute("data-provider", id)
      expect(currentBackend()).toHaveTextContent(label)
      expect(currentBackend()?.querySelector("svg, img")).toBeInTheDocument()
      advance()
    }
    expect(currentBackend()).toHaveTextContent("Claude Code")
  })

  it("holds the current backend outside the viewport and in a hidden tab", () => {
    render(<LandingHeroBackendBadge />)
    setVisible(true)
    advance()
    expect(currentBackend()).toHaveTextContent("Codex")
    setVisible(false)
    advance()
    expect(currentBackend()).toHaveTextContent("Codex")
    setVisible(true)
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    act(() => document.dispatchEvent(new Event("visibilitychange")))
    advance()
    expect(currentBackend()).toHaveTextContent("Codex")
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("updates the badge track width to match each active provider label", () => {
    const widths: Record<string, number> = {
      "Claude Code": 212.4,
      Codex: 138.2,
    }
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = widths[this.textContent ?? ""] ?? 0
      return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    render(<LandingHeroBackendBadge />)
    setVisible(true)
    const track = screen.getByTestId("landing-hero-backend-track")
    expect(track).toHaveStyle({ width: "213px" })
    advance()
    expect(track).toHaveStyle({ width: "139px" })
  })

  it("keeps the first provider visible with reduced motion", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
    render(<LandingHeroBackendBadge />)
    setVisible(true)
    advance()
    expect(currentBackend()).toHaveTextContent("Claude Code")
    expect(currentBackend()?.parentElement?.childElementCount).toBe(1)
    expect(screen.getByTestId("landing-hero-backend-track").style.width).toBe("")
    expect(screen.queryByRole("button")).toBeNull()
  })
})
