import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LandingInteractiveDemo } from "./landing-interactive-demo"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe("background workspace loading", () => {
  it("starts after the hero while the rest of the homepage is still loading, then validates frame readiness", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
    const view = render(<LandingInteractiveDemo heroReady={false} />)
    expect(screen.getByRole("heading", { name: /Imagine your team and friends here/ })).toHaveAttribute("id", "workspace-heading")
    expect(screen.queryByTitle("Alook workspace")).toBeNull()
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Loading Alook workspace")
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(10)
    act(() => window.dispatchEvent(new Event("load")))
    expect(screen.queryByTitle("Alook workspace")).toBeNull()
    view.rerender(<LandingInteractiveDemo heroReady />)
    const frame = screen.getByTitle("Alook workspace") as HTMLIFrameElement
    expect(frame).toHaveAttribute("src", "/demo")
    expect(screen.getByRole("status")).toBeVisible()
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: window, data: { type: "alook-demo-ready" } })))
    expect(screen.getByRole("status")).toBeVisible()
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://unrelated.example", source: frame.contentWindow, data: { type: "alook-demo-ready" } })))
    expect(screen.getByRole("status")).toBeVisible()
    act(() => window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "alook-demo-ready" } })))
    expect(screen.queryByRole("status")).toBeNull()
    expect(frame).toHaveAttribute("aria-hidden", "false")
  })

  it("removes the readiness listener when unmounted", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
    const remove = vi.spyOn(window, "removeEventListener")
    const view = render(<LandingInteractiveDemo heroReady={false} />)
    view.unmount()
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function))
  })

  it("starts immediately when the hero is ready without waiting for idle or homepage load", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
    const idle = vi.fn()
    vi.stubGlobal("requestIdleCallback", idle)
    render(<LandingInteractiveDemo heroReady />)
    expect(screen.getByTitle("Alook workspace")).toHaveAttribute("src", "/demo")
    expect(idle).not.toHaveBeenCalled()
  })

  it("notifies the demo iframe only once the reported annotation bounds enter the viewport", () => {
    vi.useFakeTimers()
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900)
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0))
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id))
    render(<LandingInteractiveDemo heroReady />)
    const frame = screen.getByTitle("Alook workspace") as HTMLIFrameElement
    const wrapper = frame.parentElement as HTMLElement
    const postMessage = vi.fn()
    Object.defineProperty(frame, "contentWindow", { value: { postMessage }, configurable: true })

    let frameTop = 520
    vi.spyOn(wrapper, "getBoundingClientRect").mockImplementation(() => ({
      top: frameTop,
      bottom: frameTop + 640,
      left: 0,
      right: 1080,
      width: 1080,
      height: 640,
      x: 0,
      y: frameTop,
      toJSON: () => ({}),
    }) as DOMRect)

    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "alook-demo-ready" } }))
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "alook-demo-annotation-bounds", top: 380, bottom: 530 } }))
      vi.runAllTimers()
    })
    // 520 + 530 = 1050 > 900 - 16: still below viewport.
    expect(postMessage).not.toHaveBeenCalled()

    frameTop = 260
    act(() => { window.dispatchEvent(new Event("scroll")) })
    // 260 + 530 = 790 <= 884: now completely inside viewport.
    expect(postMessage).toHaveBeenCalledWith({ type: "alook-demo-in-view" }, window.location.origin)
  })
})
