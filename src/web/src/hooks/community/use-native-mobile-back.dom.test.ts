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

function touch(type: string, x: number, y = 100, count = 1, cancelable = true, target: EventTarget = document) {
  const points = Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y }))
  const event = new Event(type, { bubbles: true, cancelable })
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : points },
    changedTouches: { value: points },
  })
  target.dispatchEvent(event)
  return event
}

function mobileHarness(parentPath: string | null = "/c/channels/s1") {
  const props = { mobile: true, gestureKey: "channel-1", parentPath, replacePath: vi.fn(), dismissShellOverlay: vi.fn(() => false) }
  return { props, renderer: render(createElement(Harness, props)) }
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

describe("confirmed mobile Back navigation", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function nativeProgress(value: number | null) {
    window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, {
      detail: { progress: value, started: value === 0 },
    }))
  }

  it.each(["Web", "Native"])("keeps iOS %s still until release and submits without an animation timer", (platform) => {
    vi.useFakeTimers()
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    if (platform === "Native") vi.stubGlobal("__TAURI__", {})
    const { props } = mobileHarness()
    const styleWrite = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty")
    touch("touchstart", 10)
    touch("touchmove", 70)
    touch("touchmove", 200)
    expect(props.replacePath).not.toHaveBeenCalled()
    expect(styleWrite).not.toHaveBeenCalled()
    touch("touchend", 200)
    touch("touchend", 200)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    expect(vi.getTimerCount()).toBe(0)
    expect(styleWrite).not.toHaveBeenCalled()
  })

  it.each(["Web", "Native"])("leaves Android %s edge input to the platform and retains confirmed Back", (platform) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android")
    if (platform === "Native") vi.stubGlobal("__TAURI__", {})
    const { props } = mobileHarness()
    touch("touchstart", 10)
    expect(touch("touchmove", 200).defaultPrevented).toBe(false)
    expect(touch("touchend", 200).defaultPrevented).toBe(false)
    expect(props.replacePath).not.toHaveBeenCalled()
    props.dismissShellOverlay.mockReturnValueOnce(true)
    dispatchBack()
    expect(props.replacePath).not.toHaveBeenCalled()
    nativeProgress(0)
    nativeProgress(0.5)
    expect(props.replacePath).not.toHaveBeenCalled()
    dispatchBack()
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("ignores legacy per-frame Native progress and cancellation, then uses the shared terminal owner", () => {
    vi.useFakeTimers()
    const { props } = mobileHarness()
    const styleWrite = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty")
    nativeProgress(0)
    nativeProgress(0.5)
    nativeProgress(null)
    vi.advanceTimersByTime(1000)
    expect(props.replacePath).not.toHaveBeenCalled()
    nativeProgress(0)
    nativeProgress(0.75)
    expect(styleWrite).not.toHaveBeenCalled()
    dispatchBack()
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["route", "resize", "background", "pagehide"])("retires a Native gesture interrupted by %s without swallowing the next Back", (reason) => {
    const { props, renderer } = mobileHarness()
    nativeProgress(0)
    nativeProgress(0.5)
    if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "next" }))
    if (reason === "resize") window.dispatchEvent(new Event("resize"))
    if (reason === "background") document.dispatchEvent(new Event("visibilitychange"))
    if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"))
    nativeProgress(0.75)
    dispatchBack()
    expect(props.replacePath).not.toHaveBeenCalled()
    dispatchBack()
    expect(props.replacePath).toHaveBeenCalledOnce()
  })

  it.each(["touchcancel", "route", "resize", "background", "unmount"])("retires touch input before confirmation on %s", (reason) => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 10)
    touch("touchmove", 200)
    if (reason === "touchcancel") touch("touchcancel", 200)
    if (reason === "route") renderer.rerender(createElement(Harness, { ...props, gestureKey: "next" }))
    if (reason === "resize") window.dispatchEvent(new Event("resize"))
    if (reason === "background") document.dispatchEvent(new Event("visibilitychange"))
    if (reason === "unmount") renderer.unmount()
    touch("touchend", 200)
    expect(props.replacePath).not.toHaveBeenCalled()
  })

  it("uses the latest callback on the same route and permits a fresh gesture after cancellation", () => {
    const { props, renderer } = mobileHarness()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchcancel", 200)
    const replacePath = vi.fn()
    renderer.rerender(createElement(Harness, { ...props, replacePath }))
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(props.replacePath).not.toHaveBeenCalled()
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("keeps reduced motion and browsers without a transition API immediately navigable", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }))
    const { props } = mobileHarness()
    touch("touchstart", 10)
    touch("touchmove", 200)
    touch("touchend", 200)
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/s1")
  })

  it("does not navigate through active composition or a disabled page owner", () => {
    const { props, renderer } = mobileHarness()
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    dispatchBack()
    expect(props.replacePath).not.toHaveBeenCalled()
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
    renderer.rerender(createElement(Harness, { ...props, pageNavigationEnabled: false }))
    dispatchBack()
    expect(props.replacePath).not.toHaveBeenCalled()
    renderer.rerender(createElement(Harness, props))
    dispatchBack()
    expect(props.replacePath).toHaveBeenCalledOnce()
    input.remove()
  })
})

describe("shared page gesture input", () => {
  let now = 0
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  function setup() {
    now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390)
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
    const interaction = { update: vi.fn(), complete: vi.fn(() => true), cancel: vi.fn(), abort: vi.fn() }
    const props = { mobile: true, parentPath: "/c/me", replacePath: vi.fn(), dismissShellOverlay: () => false,
      beginBackGesture: vi.fn(() => interaction), isBackGestureActive: vi.fn(() => false), abortBackGesture: vi.fn() }
    const renderer = render(createElement("div", null, createElement(Harness, props)))
    return { interaction, props, renderer }
  }

  it.each([false, true])("slow release chooses the nearest endpoint, completed=%s", (complete) => {
    const { interaction, props } = setup()
    touch("touchstart", 10)
    now = 600
    touch("touchmove", complete ? 240 : 150)
    now = 800
    touch("touchend", complete ? 240 : 150)
    expect(interaction.update).toHaveBeenLastCalledWith((complete ? 230 : 140) / 390)
    expect(interaction.complete).toHaveBeenCalledTimes(complete ? 1 : 0)
    expect(interaction.cancel).toHaveBeenCalledTimes(complete ? 0 : 1)
    expect(props.replacePath).not.toHaveBeenCalled()
  })

  it("lets a short forward fling complete and a reverse fling cancel past halfway", () => {
    const { interaction, props } = setup()
    touch("touchstart", 10)
    now = 40
    touch("touchmove", 65)
    now = 50
    touch("touchend", 65)
    expect(interaction.complete).toHaveBeenCalledOnce()
    touch("touchstart", 10)
    now = 500
    touch("touchmove", 300)
    now = 520
    touch("touchmove", 270)
    now = 530
    touch("touchend", 270)
    expect(interaction.complete).toHaveBeenCalledOnce()
    expect(interaction.cancel).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
  })

  it("uses the same progress, completion and cancellation owner for native input", () => {
    const { interaction, props } = setup()
    const progress = (value: number | null) => window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT,
      { detail: { progress: value, started: value === 0 } }))
    progress(0); progress(.4); progress(null)
    expect(interaction.update).toHaveBeenCalledWith(.4)
    expect(interaction.cancel).toHaveBeenCalledOnce()
    progress(0); progress(.7); dispatchBack()
    expect(interaction.complete).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
  })

  it("consumes repeated Back while the released snapshot is still settling", () => {
    const { interaction, props } = setup()
    touch("touchstart", 10)
    now = 600
    touch("touchmove", 250)
    touch("touchend", 250)
    expect(interaction.complete).toHaveBeenCalledOnce()
    props.isBackGestureActive.mockReturnValue(true)
    dispatchBack()
    expect(props.replacePath).not.toHaveBeenCalled()
    window.dispatchEvent(new CustomEvent(NATIVE_MOBILE_BACK_PROGRESS_EVENT, { detail: { progress: 0, started: true } }))
    dispatchBack()
    expect(props.beginBackGesture).toHaveBeenCalledOnce()
    expect(props.replacePath).not.toHaveBeenCalled()
    props.isBackGestureActive.mockReturnValue(false)
    dispatchBack()
    expect(props.replacePath).toHaveBeenCalledExactlyOnceWith("/c/me")
  })

  it("aborts the released snapshot if a real dialog becomes the Back owner", async () => {
    const { interaction, props, renderer } = setup()
    touch("touchstart", 10)
    now = 600
    touch("touchmove", 250)
    touch("touchend", 250)
    expect(interaction.complete).toHaveBeenCalledOnce()
    props.isBackGestureActive.mockReturnValue(true)
    renderer.rerender(createElement("div", null,
      createElement(Harness, props),
      createElement(Dialog, { defaultOpen: true }, createElement(DialogContent, null,
        createElement(DialogTitle, null, "Interrupt settling"),
        createElement(DialogDescription, null, "Test content"),
      )),
    ))
    await screen.findByRole("dialog", { name: "Interrupt settling" })
    expect(props.abortBackGesture).toHaveBeenCalled()
    expect(props.replacePath).not.toHaveBeenCalled()
  })

  it("reserves only the page edge from the message-row pointer handler", () => {
    setup()
    const row = document.createElement("div")
    document.body.append(row)
    const reply = vi.fn()
    row.addEventListener("pointerdown", reply)
    const pointer = (x: number) => {
      const event = new Event("pointerdown", { bubbles: true })
      Object.defineProperties(event, { pointerType: { value: "touch" }, clientX: { value: x } })
      row.dispatchEvent(event)
    }
    pointer(12)
    expect(reply).not.toHaveBeenCalled()
    pointer(60)
    expect(reply).toHaveBeenCalledOnce()
    row.remove()
  })

  it("leaves a nested horizontal scroller and form control with their own input", () => {
    const { props } = setup()
    const scroller = document.createElement("div")
    scroller.style.overflowX = "auto"
    Object.defineProperties(scroller, { clientWidth: { value: 100 }, scrollWidth: { value: 300 } })
    const button = document.createElement("button")
    scroller.append(button)
    document.body.append(scroller)
    for (const target of [scroller, button]) {
      touch("touchstart", 10, 100, 1, true, target)
      expect(touch("touchmove", 250, 100, 1, true, target).defaultPrevented).toBe(false)
      touch("touchend", 250, 100, 1, true, target)
    }
    expect(props.beginBackGesture).not.toHaveBeenCalled()
    expect(props.replacePath).not.toHaveBeenCalled()
    scroller.remove()
  })
})
