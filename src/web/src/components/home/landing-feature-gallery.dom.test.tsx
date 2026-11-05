import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { LandingFeatureGallery } from "./landing-feature-gallery"
import { sceneDurationMs } from "./landing-shell-motion-timeline"

vi.mock("./landing-feature-scene", () => ({ default: ({ feature }: { feature: string }) => <div data-testid="active-feature">{feature}</div> }))
vi.mock("@/lib/analytics", () => ({ trackLandingCtaClicked: vi.fn() }))
let intersect: IntersectionObserverCallback
let reduced = false
const disconnect = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  reduced = false
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback }
    observe() {}
    disconnect = disconnect
  })
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ media, matches: reduced, addEventListener() {}, removeEventListener() {} })))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function show(visible = true) {
  await act(async () => { intersect([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver) })
}
async function advance(time = 30000) { await act(async () => { vi.advanceTimersByTime(time) }) }

describe("feature gallery", () => {
  it("loads only after entering view and keeps the selected layout offscreen", async () => {
    const view = render(<LandingFeatureGallery isLoggedIn={false} />)
    expect(screen.queryByTestId("active-feature")).toBeNull()
    await show()
    expect(screen.getByTestId("active-feature")).toHaveTextContent("product")
    fireEvent.click(screen.getByRole("tab", { name: "Agent identity" }))
    expect(screen.getAllByTestId("active-feature")).toHaveLength(1)
    expect(screen.getByTestId("active-feature")).toHaveTextContent("identity")
    await show(false)
    expect(screen.getByTestId("active-feature")).toHaveTextContent("identity")
    view.unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it("rotates after the scene cycle, pauses on hover, and stops after manual selection", async () => {
    render(<LandingFeatureGallery isLoggedIn={false} />)
    await show()
    await advance(Math.max(15000, sceneDurationMs("server") + 1500) - 1)
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaboration")
    await advance(1)
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Free and local")
    fireEvent.mouseEnter(screen.getByRole("region"))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Free and local")
    fireEvent.mouseLeave(screen.getByRole("region"))
    fireEvent.click(screen.getByRole("tab", { name: "Remote control" }))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Remote control")
    expect(screen.queryByRole("button", { name: /feature rotation/ })).toBeNull()
  })

  it("supports arrow keys with a feature title and CTA", async () => {
    render(<LandingFeatureGallery isLoggedIn={false} />)
    await show()
    expect(screen.getByRole("heading")).toHaveTextContent("Chat with shared agents")
    expect(screen.getByRole("link", { name: "Share your agent" })).toHaveAttribute("href", "/sign-in")
    const tab = screen.getByRole("tab", { name: "Collaboration" })
    // Keyboard users reach the tab list first; the shared Tabs roving focus starts there.
    act(() => tab.focus())
    fireEvent.keyDown(tab, { key: "End" })
    await advance(50)
    expect(screen.getByRole("tab", { name: "Persistent Memory" })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole("tab", { name: "Persistent Memory" }), { key: "ArrowRight" })
    await advance(50)
    expect(tab).toHaveFocus()
    await advance()
    expect(tab).toHaveAttribute("aria-selected", "true")
  })

  it("pauses in a hidden document and clears timers on unmount", async () => {
    const view = render(<LandingFeatureGallery isLoggedIn={false} />)
    await show()
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    fireEvent(document, new Event("visibilitychange"))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaboration")
    expect(screen.getByTestId("active-feature")).toHaveTextContent("product")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    fireEvent(document, new Event("visibilitychange"))
    await act(async () => {})
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Free and local")
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not rotate for reduced motion or while hidden", async () => {
    reduced = true
    render(<LandingFeatureGallery isLoggedIn={false} />)
    await show()
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaboration")
    expect(screen.queryByRole("button", { name: "Pause feature rotation" })).toBeNull()
    await show(false)
    await advance()
    expect(screen.getByTestId("active-feature")).toHaveTextContent("product")
  })
})
