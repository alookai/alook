import { createElement, StrictMode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  NATIVE_MOBILE_BACK_EVENT,
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

describe("removed page swipes", () => {
  it.each(["iPhone", "Android WebView"])("leaves touch movements and old progress inert on %s while Back uses the latest parent", (userAgent) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent)
    const replacePath = vi.fn()
    const props = { parentPath: "/c/me", replacePath, dismissShellOverlay: () => false }
    const renderer = render(createElement(Harness, props))
    for (const [type, x, y] of [["touchstart", 8, 100], ["touchmove", 180, 102], ["touchend", 180, 102],
      ["touchstart", 8, 100], ["touchmove", 10, 220], ["touchend", 10, 220]] as const) {
      const points = [{ identifier: 1, clientX: x, clientY: y }]
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : points }, changedTouches: { value: points } })
      act(() => { document.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
    act(() => { window.dispatchEvent(new CustomEvent("alook:native-back-progress", { detail: { progress: 1, started: true } })) })
    expect(replacePath).not.toHaveBeenCalled()
    renderer.rerender(createElement(Harness, { ...props, parentPath: "/c/channels/new-parent" }))
    act(() => { dispatchBack() })
    expect(replacePath).toHaveBeenCalledExactlyOnceWith("/c/channels/new-parent")
    renderer.unmount()
    vi.restoreAllMocks()
  })
})
