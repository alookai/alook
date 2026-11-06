import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { useNativeSafeAreaTop } from "./use-native-safe-area-top"

const keys = ["__TAURI__", "__alookNativeGeometry"]
const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(window, key)]))
const subscribers = new Set<() => void>()
const ready = (top: number) => ({ status: "ready", insets: { top, right: 0, bottom: 0, left: 0, viewportWidth: 1000, viewportHeight: 800, caption: false } })
let state: ReturnType<typeof ready> | { status: "pending" | "error"; insets: null }
const publish = (next: typeof state) => { state = next; for (const subscriber of subscribers) subscriber() }
beforeEach(() => {
  subscribers.clear()
  state = ready(0)
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "__alookNativeGeometry", { configurable: true, value: {
    getSnapshot: () => state,
    subscribe: (callback: () => void) => { subscribers.add(callback); return () => subscribers.delete(callback) },
  } })
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(window, key, descriptor)
    else Reflect.deleteProperty(window, key)
  }
})

describe("mobile raw top projection from the canonical document geometry", () => {
  it("connects a consumer mounted before the document geometry owner is ready", () => {
    const owner = Object.getOwnPropertyDescriptor(window, "__alookNativeGeometry")!
    Reflect.deleteProperty(window, "__alookNativeGeometry")
    const view = renderHook(useNativeSafeAreaTop)
    expect(view.result.current).toBeNull()
    act(() => {
      Object.defineProperty(window, "__alookNativeGeometry", owner)
      window.dispatchEvent(new Event("alook:geometry-ready"))
    })
    expect(view.result.current).toBe(0)
    expect(subscribers.size).toBe(1)
    act(() => publish(ready(32)))
    expect(view.result.current).toBe(32)
    view.unmount()
    expect(subscribers.size).toBe(0)
  })
  it("removes readiness listeners when a consumer leaves before owner creation", () => {
    const owner = Object.getOwnPropertyDescriptor(window, "__alookNativeGeometry")!
    Reflect.deleteProperty(window, "__alookNativeGeometry")
    const view = renderHook(useNativeSafeAreaTop)
    view.unmount()
    act(() => {
      Object.defineProperty(window, "__alookNativeGeometry", owner)
      window.dispatchEvent(new Event("alook:geometry-ready"))
    })
    expect(subscribers.size).toBe(0)
  })
  it("uses the original mobile top and unsubscribes when the consumer leaves", () => {
    const view = renderHook(useNativeSafeAreaTop)
    expect(view.result.current).toBe(0)
    act(() => publish(ready(62)))
    expect(view.result.current).toBe(62)
    act(() => publish(ready(0)))
    expect(view.result.current).toBe(0)
    view.unmount()
    expect(subscribers.size).toBe(0)
  })
  it("keeps unknown/error distinct from a real measured zero", () => {
    const view = renderHook(useNativeSafeAreaTop)
    for (const status of ["pending", "error"] as const) {
      act(() => publish({ status, insets: null }))
      expect(view.result.current).toBeNull()
    }
    act(() => publish(ready(0)))
    expect(view.result.current).toBe(0)
  })
  it.each(["browser", "desktop"])("preserves the mobile-only business rule in a %s", mode => {
    if (mode === "browser") Reflect.deleteProperty(window, "__TAURI__")
    else vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh")
    expect(renderHook(useNativeSafeAreaTop).result.current).toBeNull()
  })
})
