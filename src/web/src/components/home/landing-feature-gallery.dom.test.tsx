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
    fireEvent.click(screen.getByRole("tab", { name: "Your agent" }))
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
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaborate")
    await advance(1)
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Your agent")
    fireEvent.mouseEnter(screen.getByRole("region"))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Your agent")
    fireEvent.mouseLeave(screen.getByRole("region"))
    fireEvent.click(screen.getByRole("tab", { name: "On your phone" }))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("On your phone")
    fireEvent.click(screen.getByRole("button", { name: "Resume feature rotation" }))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Your setup")
  })

  it("supports arrow keys and routes the selected CTA for signed-in users", async () => {
    render(<LandingFeatureGallery isLoggedIn />)
    await show()
    const tab = screen.getByRole("tab", { name: "Collaborate" })
    fireEvent.keyDown(tab, { key: "End" })
    expect(screen.getByRole("tab", { name: "Your setup" })).toHaveFocus()
    expect(screen.getByRole("link")).toHaveAttribute("href", "/c/me")
    fireEvent.keyDown(screen.getByRole("tab", { name: "Your setup" }), { key: "ArrowRight" })
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
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaborate")
    expect(screen.getByTestId("active-feature")).toHaveTextContent("product")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" })
    fireEvent(document, new Event("visibilitychange"))
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "Pause feature rotation" }))
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaborate")
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not rotate for reduced motion or while hidden", async () => {
    reduced = true
    render(<LandingFeatureGallery isLoggedIn={false} />)
    await show()
    await advance()
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Collaborate")
    expect(screen.queryByRole("button", { name: "Pause feature rotation" })).toBeNull()
    await show(false)
    await advance()
    expect(screen.getByTestId("active-feature")).toHaveTextContent("product")
  })
})
