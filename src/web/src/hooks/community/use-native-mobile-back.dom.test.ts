import { createElement, StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  NATIVE_MOBILE_BACK_EVENT,
  NATIVE_MOBILE_BACK_PROGRESS_EVENT,
  useNativeMobileBack,
} from "./use-native-mobile-back"

function Harness(props: Parameters<typeof useNativeMobileBack>[0]) {
  useNativeMobileBack(props)
  return null
}

function dispatchBack() {
  const event = new Event(NATIVE_MOBILE_BACK_EVENT, { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe("Tauri public Android Back entry", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function installBridge(pending: Array<Promise<{ unregister: () => Promise<void> }>> = []) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android WebView")
    const callbacks: Array<(payload: { canGoBack: boolean }) => void> = []
    const unregister = vi.fn(async () => {})
    const register = vi.fn((callback: (payload: { canGoBack: boolean }) => void) => {
      callbacks.push(callback)
      return pending.shift() ?? Promise.resolve({ unregister })
    })
    vi.stubGlobal("__TAURI__", { app: { onBackButtonPress: register } })
    return { callbacks, unregister, register }
  }

  it("registers once and uses the current structural parent and consumed root policy", async () => {
    const { callbacks, unregister, register } = installBridge()
    expect("__TAURI__" in window).toBe(true)
    const replacePath = vi.fn()
    const props = { dismissShellOverlay: () => false, parentPath: "/c/channels/s1", replacePath }
    const renderer = render(createElement(Harness, props))
    await waitFor(() => { expect(register).toHaveBeenCalledOnce() })
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")

    renderer.rerender(createElement(Harness, { ...props, parentPath: "/c/me" }))
    act(() => { callbacks[0]({ canGoBack: false }) })
    expect(replacePath).toHaveBeenLastCalledWith("/c/me")
    renderer.rerender(createElement(Harness, { ...props, parentPath: null }))
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledOnce()

    renderer.unmount()
    await waitFor(() => { expect(unregister).toHaveBeenCalledOnce() })
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledTimes(2)
  })

  it("gives the public callback to a real top Dialog before the page", async () => {
    const { callbacks } = installBridge()
    const replacePath = vi.fn()
    const close = vi.fn()
    const renderer = render(createElement("div", null,
      createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }),
      createElement(Dialog, { defaultOpen: true, onOpenChange: (open) => { if (!open) close() } },
        createElement(DialogContent, null,
          createElement(DialogTitle, null, "Public native owner"),
          createElement(DialogDescription, null, "Test content"),
        ),
      ),
    ))
    await screen.findByRole("dialog", { name: "Public native owner" })
    act(() => { callbacks[0]({ canGoBack: true }) })
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull() })
    expect(close).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("releases a late registration and fences its callback from the next scope", async () => {
    const pending = Promise.withResolvers<{ unregister: () => Promise<void> }>()
    const { callbacks, register, unregister } = installBridge([pending.promise])
    const oldReplace = vi.fn()
    const first = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath: oldReplace }))
    first.unmount()
    const nextReplace = vi.fn()
    const next = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/channels/new", replacePath: nextReplace }))
    expect(register).toHaveBeenCalledTimes(2)
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(oldReplace).not.toHaveBeenCalled()
    expect(nextReplace).not.toHaveBeenCalled()
    const lateUnregister = vi.fn(async () => {})
    await act(async () => { pending.resolve({ unregister: lateUnregister }); await pending.promise })
    expect(lateUnregister).toHaveBeenCalledOnce()
    act(() => { callbacks[1]({ canGoBack: true }) })
    expect(nextReplace).toHaveBeenCalledExactlyOnceWith("/c/channels/new")
    next.unmount()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it("fences the retired StrictMode setup and unregisters each resolved handle once", async () => {
    const first = Promise.withResolvers<{ unregister: () => Promise<void> }>()
    const second = Promise.withResolvers<{ unregister: () => Promise<void> }>()
    const { callbacks, register } = installBridge([first.promise, second.promise])
    const replacePath = vi.fn()
    const renderer = render(createElement(StrictMode, null,
      createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }),
    ))
    expect(register).toHaveBeenCalledTimes(2)
    act(() => { callbacks[0]({ canGoBack: true }); callbacks[1]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
    const firstUnregister = vi.fn(async () => {})
    const secondUnregister = vi.fn(async () => {})
    await act(async () => {
      first.resolve({ unregister: firstUnregister })
      second.resolve({ unregister: secondUnregister })
      await Promise.all([first.promise, second.promise])
    })
    expect(firstUnregister).toHaveBeenCalledOnce()
    expect(secondUnregister).not.toHaveBeenCalled()
    renderer.unmount()
    expect(secondUnregister).toHaveBeenCalledOnce()
    act(() => { callbacks[0]({ canGoBack: true }); callbacks[1]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledOnce()
  })

  it.each([false, true])("retires on pagehide persisted=%s without relying on React unmount", async (persisted) => {
    const { callbacks, register, unregister } = installBridge()
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }))
    await act(async () => {})
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted })) })
    expect(unregister).toHaveBeenCalledOnce()
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(replacePath).not.toHaveBeenCalled()
    renderer.unmount()
    act(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })) })
    expect(register).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it("restores a new BFCache subscription after pagehide and retires a late old handle", async () => {
    const pending = Promise.withResolvers<{ unregister: () => Promise<void> }>()
    const { callbacks, register, unregister } = installBridge([pending.promise])
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }))
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
    act(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })) })
    expect(register).toHaveBeenCalledOnce()
    act(() => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })) })
    expect(register).toHaveBeenCalledTimes(2)
    const lateUnregister = vi.fn(async () => {})
    await act(async () => { pending.resolve({ unregister: lateUnregister }); await pending.promise })
    expect(lateUnregister).toHaveBeenCalledOnce()
    expect(unregister).not.toHaveBeenCalled()
    act(() => { callbacks[0]({ canGoBack: true }); callbacks[1]({ canGoBack: true }) })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
    act(() => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
    expect(unregister).toHaveBeenCalledOnce()
    renderer.unmount()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it.each(["iPhone", "Macintosh", "Linux desktop"])("does not register Android Back on %s", (userAgent) => {
    const { register } = installBridge()
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }))
    expect(register).not.toHaveBeenCalled()
    act(() => { dispatchBack() })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
    renderer.unmount()
  })

  it.each([undefined, { app: {} }])("preserves the existing event path without a public API: %s", (bridge) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android WebView")
    vi.stubGlobal("__TAURI__", bridge)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }))
    act(() => { dispatchBack() })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
    renderer.unmount()
  })

  it("reports a rejected registration without retry or an unhandled rejection", async () => {
    const error = new Error("registration denied")
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const { register } = installBridge([Promise.reject(error)])
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: null, replacePath: vi.fn() }))
    await waitFor(() => { expect(report).toHaveBeenCalledWith("Native Back listener failed", error) })
    expect(register).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("reports unregister rejection and keeps the retired callback inert", async () => {
    const error = new Error("removal denied")
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const unregister = vi.fn(async () => { throw error })
    const { callbacks } = installBridge([Promise.resolve({ unregister })])
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, { dismissShellOverlay: () => false, parentPath: "/c/me", replacePath }))
    await act(async () => {})
    renderer.unmount()
    await waitFor(() => { expect(report).toHaveBeenCalledWith("Native Back listener failed", error) })
    act(() => { callbacks[0]({ canGoBack: true }) })
    expect(replacePath).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledOnce()
  })
})

describe("useNativeMobileBack", () => {
  afterEach(() => {
    document.querySelectorAll('[data-native-back-test-layer]').forEach((node) => node.remove())
  })

  it("does not treat arbitrary dialog-slot markup as a Back owner", () => {
    const dismissShellOverlay = vi.fn(() => false)
    const replacePath = vi.fn()
    const keydown = vi.fn()
    document.addEventListener("keydown", keydown, { once: true })
    const layer = document.createElement("div")
    layer.dataset.slot = "dialog-content"
    layer.dataset.nativeBackTestLayer = "true"
    document.body.append(layer)
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/me",
      replacePath,
    }))

    const event = dispatchBack()

    expect(event.defaultPrevented).toBe(true)
    expect(keydown).not.toHaveBeenCalled()
    expect(dismissShellOverlay).toHaveBeenCalledOnce()
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
    document.removeEventListener("keydown", keydown)
    renderer.unmount()
  })

  it("dismisses a shell overlay before replacing a detail route", () => {
    const dismissShellOverlay = vi.fn(() => true)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/me",
      replacePath,
    }))

    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(dismissShellOverlay).toHaveBeenCalledOnce()
    expect(replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("replaces a detail route and consumes back at a root route", () => {
    const dismissShellOverlay = vi.fn(() => false)
    const replacePath = vi.fn()
    const renderer = render(createElement(Harness, {
      dismissShellOverlay,
      parentPath: "/c/channels/s1",
      replacePath,
    }))

    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(replacePath).toHaveBeenCalledWith("/c/channels/s1")

    renderer.rerender(createElement(Harness, {
      dismissShellOverlay,
      parentPath: null,
      replacePath,
    }))
    expect(dispatchBack().defaultPrevented).toBe(true)
    renderer.unmount()
    expect(dispatchBack().defaultPrevented).toBe(false)
  })
})

function touch(type: string, x: number, y = 100, count = 1, cancelable = true) {
  const points = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y }))
  const event = new Event(type, { bubbles: true, cancelable })
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : points },
    changedTouches: { value: points },
  })
  document.dispatchEvent(event)
  return event
}

function mobileHarness(parentPath: string | null = "/c/channels/s1") {
  const props = { mobile: true, gestureKey: "channel-1", parentPath, replacePath: vi.fn(), dismissShellOverlay: vi.fn(() => false) }
  return { props, renderer: render(createElement(Harness, props)) }
}

function transition(target: HTMLElement, type = "transitionend", propertyName = "transform") {
  const event = new Event(type, { bubbles: true })
  Object.defineProperty(event, "propertyName", { value: propertyName })
  act(() => { target.dispatchEvent(event) })
}

describe("mobile edge parent gesture", () => {
  it("replaces the parent once at the shared edge boundary, on release only", () => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 24)
    expect(touch("touchmove", 100).defaultPrevented).toBe(true)
    expect(props.replacePath).not.toHaveBeenCalled()
    touch("touchend", 100)
    touch("touchend", 100)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    renderer.unmount()
  })

  it.each([
    [25, 110, 100, 110, 100],
    [0, 63, 100, 63, 100],
    [12, 8, 125, 100, 130],
    [12, 0, 100, 100, 100],
    [12, 100, 100, 20, 100],
    [12, 100, 100, 100, 220],
  ])("rejects outside/short/vertical/left/reversed/diagonal (%s,%s,%s,%s,%s)", (start, moveX, moveY, endX, endY) => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", start)
    touch("touchmove", moveX, moveY)
    touch("touchend", endX, endY)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("leaves vertical edge scrolling and taps uncancelled", () => {
    const { props, renderer } = mobileHarness()
    expect(touch("touchstart", 10).defaultPrevented).toBe(false)
    expect(touch("touchmove", 12, 130).defaultPrevented).toBe(false)
    expect(touch("touchend", 12, 150).defaultPrevented).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it.each(["touchcancel", "multitouch", "browser-scroll", "route", "desktop", "unmount"])("cancels on %s", (reason) => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 10)
    touch("touchmove", 100)
    if (reason === "touchcancel") touch("touchcancel", 100)
    if (reason === "browser-scroll") touch("touchmove", 110, 100, 1, false)
    if (reason === "multitouch") touch("touchmove", 100, 100, 2)
    if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "channel-2" }))
    if (reason === "desktop") renderer.rerender(createElement(Harness, { ...props, mobile: false }))
    if (reason === "unmount") renderer.unmount()
    touch("touchend", 120)
    expect(props.replacePath).not.toHaveBeenCalled()
    if (reason !== "unmount") renderer.unmount()
  })

  it("rejects a multi-finger start and consumes native back at the picker", () => {
    const { props, renderer } = mobileHarness(null)
    touch("touchstart", 10, 100, 2)
    expect(touch("touchmove", 100).defaultPrevented).toBe(false)
    touch("touchend", 100)
    touch("touchstart", 10)
    touch("touchmove", 100)
    touch("touchend", 100)
    expect(dispatchBack().defaultPrevented).toBe(true)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("dismisses overlays before a parent navigation", () => {
    const { props, renderer } = mobileHarness()
    props.dismissShellOverlay.mockReturnValue(true)
    touch("touchstart", 10)
    touch("touchmove", 100)
    touch("touchend", 100)
    expect(props.dismissShellOverlay).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })
})

describe("layered mobile back motion", () => {
  const roots: HTMLElement[] = []
  function mounted() {
    const root = document.createElement("div")
    root.dataset.mobileBackSurface = "detail"
    Object.defineProperty(root, "clientWidth", { value: 390 })
    const foreground = document.createElement("div")
    foreground.dataset.panel = "true"
    foreground.id = "main"
    root.appendChild(foreground)
    document.body.append(root)
    roots.push(root)
    return { ...mobileHarness(), root, foreground }
  }
  afterEach(() => {
    roots.splice(0).forEach((root) => root.remove())
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(["Web", "Native"])("keeps iOS %s touch painting and completes once after release", (platform) => {
    vi.useFakeTimers()
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")
    if (platform === "Native") vi.stubGlobal("__TAURI__", {})
    const { root, foreground, props, renderer } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 70)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe(platform === "Native" ? "60px" : "")
    expect(root.dataset.mobileBackPhase).toBe(platform === "Native" ? "dragging" : undefined)
    touch("touchmove", 180)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe(platform === "Native" ? "170px" : "")
    expect(root.style.getPropertyValue("--mobile-back-progress")).toBe(platform === "Native" ? `${170 / 390}` : "")
    expect(root.dataset.mobileBackPhase).toBe(platform === "Native" ? "dragging" : undefined)
    expect(props.replacePath).not.toHaveBeenCalled()
    touch("touchend", 180)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe("390px")
    expect(root.dataset.mobileBackPhase).toBe("settling")
    if (platform === "Native") transition(foreground)
    touch("touchstart", 10)
    touch("touchend", 180)
    vi.advanceTimersByTime(199)
    expect(props.replacePath).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    if (platform === "Web") {
      expect(props.replacePath).not.toHaveBeenCalled()
      transition(foreground)
    }
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    expect(root.dataset.mobileBackPhase).toBe("committing")
    renderer.unmount()
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe("")
  })

  it.each(["Web", "Native"])("leaves Android %s edge touch to the platform while retaining public Back", (platform) => {
    vi.useFakeTimers()
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Linux; Android 16)")
    if (platform === "Native") vi.stubGlobal("__TAURI__", {})
    const { root, foreground, props } = mounted()
    touch("touchstart", 10)
    expect(touch("touchmove", 200).defaultPrevented).toBe(false)
    expect(touch("touchend", 200).defaultPrevented).toBe(false)
    touch("touchcancel", 200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe("")
    expect(props.dismissShellOverlay).not.toHaveBeenCalled()
    expect(props.replacePath).not.toHaveBeenCalled()

    props.dismissShellOverlay.mockReturnValueOnce(true)
    dispatchBack()
    expect(props.dismissShellOverlay).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
    if (platform === "Native") {
      window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: 0, started: true } }))
      window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: 0.5 } }))
      expect(root.style.getPropertyValue("--mobile-back-x")).toBe("195px")
    }
    dispatchBack()
    expect(root.dataset.mobileBackPhase).toBe("settling")
    vi.advanceTimersByTime(200)
    if (platform === "Web") {
      expect(props.replacePath).not.toHaveBeenCalled()
      transition(foreground)
    }
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("keeps settling across callback changes on the same committed route", () => {
    vi.useFakeTimers()
    const { foreground, props, renderer } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    const replacePath = vi.fn()
    renderer.rerender(createElement(Harness, { ...props, replacePath, dismissShellOverlay: () => false }))
    vi.advanceTimersByTime(200)
    expect(props.replacePath).not.toHaveBeenCalled()
    expect(replacePath).not.toHaveBeenCalled()
    transition(foreground)
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    renderer.unmount()
  })

  it("tracks native system progress, cancels, then commits once through the shared settle", () => {
    vi.useFakeTimers()
    const { root, props, renderer } = mounted()
    const progress = (value: number | null) => window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: value, started: value === 0 } }))
    progress(0)
    progress(0.5)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe("195px")
    expect(props.replacePath).not.toHaveBeenCalled()
    progress(null)
    vi.advanceTimersByTime(200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    progress(0)
    progress(0.75)
    dispatchBack()
    dispatchBack()
    vi.advanceTimersByTime(199)
    expect(props.replacePath).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    renderer.unmount()
    progress(0.5)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
  })

  it.each(["route", "resize", "background"])("ignores a late native commit after %s interrupts its gesture", (reason) => {
    vi.useFakeTimers()
    vi.stubGlobal("__TAURI__", {})
    const { props, renderer } = mounted()
    const progress = (value: number) => window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: value, started: value === 0 } }))
    progress(0)
    progress(0.5)
    if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "new-route" }))
    if (reason === "resize") window.dispatchEvent(new Event("resize"))
    if (reason === "background") document.dispatchEvent(new Event("visibilitychange"))
    progress(0.75)
    dispatchBack()
    vi.advanceTimersByTime(300)
    expect(props.replacePath).not.toHaveBeenCalled()
    dispatchBack()
    vi.advanceTimersByTime(200)
    expect(props.replacePath).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it.each(["Web", "Native"])("cancels a short held %s drag without navigating", (platform) => {
    vi.useFakeTimers()
    if (platform === "Native") vi.stubGlobal("__TAURI__", {})
    const { root, props, renderer } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 70)
    vi.advanceTimersByTime(150)
    touch("touchend", 70)
    expect(root.style.getPropertyValue("--mobile-back-x")).toBe(platform === "Native" ? "0px" : "")
    expect(root.dataset.mobileBackPhase).toBe(platform === "Native" ? "settling" : undefined)
    vi.advanceTimersByTime(200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it("accepts a new Web gesture immediately after touch cancellation", () => {
    vi.useFakeTimers()
    const { root, foreground, props } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchcancel", 200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(root.dataset.mobileBackPhase).toBe("settling")
    vi.advanceTimersByTime(200)
    expect(props.replacePath).not.toHaveBeenCalled()
    transition(foreground)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("waits for the foreground transform completion instead of elapsed timers or other transitions", () => {
    vi.useFakeTimers()
    const { root, foreground, props } = mounted()
    const child = document.createElement("button")
    foreground.appendChild(child)
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    vi.advanceTimersByTime(1000)
    transition(foreground, "transitionend", "opacity")
    transition(child)
    window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: 0, started: true } }))
    dispatchBack()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(root.dataset.mobileBackPhase).toBe("settling")
    expect(props.replacePath).not.toHaveBeenCalled()
    transition(foreground)
    transition(foreground)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("uses the thread foreground completion instead of the containing main panel", () => {
    const { foreground, props } = mounted()
    const split = document.createElement("div")
    split.dataset.mobileBackThread = "true"
    const thread = document.createElement("div")
    thread.dataset.panel = "true"
    thread.id = "thread"
    split.appendChild(thread)
    foreground.appendChild(split)
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    transition(foreground)
    expect(props.replacePath).not.toHaveBeenCalled()
    transition(thread)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("retires a cancelled Web transition and permits a new confirmed gesture", () => {
    const { root, foreground, props } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    transition(foreground, "transitioncancel")
    transition(foreground)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    transition(foreground)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("retains direct Back when no animatable foreground exists", () => {
    const { root, foreground, props } = mounted()
    foreground.remove()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it.each(["touchcancel", "route", "resize", "background", "unmount"])("cancels queued navigation on %s", (reason) => {
    vi.useFakeTimers()
    const { root, foreground, props, renderer } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 200)
    if (reason === "touchcancel") touch("touchcancel", 200)
    else {
      touch("touchend", 200)
      if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "new-route" }))
      if (reason === "resize") window.dispatchEvent(new Event("resize"))
      if (reason === "background") document.dispatchEvent(new Event("visibilitychange"))
      if (reason === "unmount") renderer.unmount()
    }
    vi.advanceTimersByTime(300)
    transition(foreground)
    expect(props.replacePath).not.toHaveBeenCalled()
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    if (reason !== "unmount") renderer.unmount()
  })

  it("keeps reduced motion navigation immediate with no spatial settle", () => {
    vi.useFakeTimers()
    vi.stubGlobal("matchMedia", () => ({ matches: true }))
    const { root, props, renderer } = mounted()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    vi.advanceTimersByTime(300)
    expect(props.replacePath).toHaveBeenCalledOnce()
    renderer.unmount()
  })

  it("dismisses an overlay without committing the moving page", () => {
    vi.useFakeTimers()
    const { root, props, renderer } = mounted()
    props.dismissShellOverlay.mockReturnValue(true)
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    vi.advanceTimersByTime(200)
    expect(props.dismissShellOverlay).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
    expect(root.hasAttribute("data-mobile-back-phase")).toBe(false)
    renderer.unmount()
  })
})
