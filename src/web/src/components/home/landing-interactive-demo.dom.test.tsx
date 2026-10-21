import { act, render, screen } from "@/test/react-dom-harness"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LandingInteractiveDemo } from "./landing-interactive-demo"

vi.mock("@/components/brand/alook-loading/AlookLoading", () => ({ AlookLoading: ({ label }: { label: string }) => <span role="status">{label}</span> }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe("background workspace loading", () => {
  it("waits for the homepage load and idle time, then keeps the loader until its own frame is ready", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("loading")
    let idle!: IdleRequestCallback
    const request = vi.fn((callback: IdleRequestCallback) => { idle = callback; return 7 })
    vi.stubGlobal("requestIdleCallback", request)
    vi.stubGlobal("cancelIdleCallback", vi.fn())
    render(<LandingInteractiveDemo />)
    expect(screen.queryByTitle("Alook workspace")).toBeNull()
    expect(request).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new Event("load")))
    expect(request).toHaveBeenCalledOnce()
    expect(screen.queryByTitle("Alook workspace")).toBeNull()
    act(() => idle({ didTimeout: false, timeRemaining: () => 10 }))
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

  it("cancels deferred work when unmounted", () => {
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete")
    vi.stubGlobal("requestIdleCallback", vi.fn(() => 9))
    const cancel = vi.fn()
    vi.stubGlobal("cancelIdleCallback", cancel)
    const view = render(<LandingInteractiveDemo />)
    view.unmount()
    expect(cancel).toHaveBeenCalledWith(9)
  })

  it("yields after load when idle callbacks are unavailable", () => {
    vi.useFakeTimers()
    vi.spyOn(document, "readyState", "get").mockReturnValue("complete")
    vi.stubGlobal("requestIdleCallback", undefined)
    render(<LandingInteractiveDemo />)
    expect(screen.queryByTitle("Alook workspace")).toBeNull()
    act(() => vi.advanceTimersByTime(200))
    expect(screen.getByTitle("Alook workspace")).toHaveAttribute("src", "/demo")
  })
})
