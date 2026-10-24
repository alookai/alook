import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { useNativeSafeAreaTop } from "./use-native-safe-area-top"

const originals = new Map(
  ["AlookNative", "webkit", "__TAURI__"].map((key) => [key, Object.getOwnPropertyDescriptor(window, key)]),
)

function setBridge(key: string, value: unknown) {
  Object.defineProperty(window, key, { configurable: true, value })
}

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("iPhone")
  setBridge("__TAURI__", {})
  setBridge("AlookNative", undefined)
  setBridge("webkit", undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(window, key, descriptor)
    else Reflect.deleteProperty(window, key)
  }
})

describe("native top safe-area input", () => {
  it("reads Android's original inset on mount and follows native changes", () => {
    let top = 0
    setBridge("AlookNative", { getSafeAreaTop: () => top })
    const view = renderHook(useNativeSafeAreaTop)
    expect(view.result.current).toBe(0)

    top = 62
    act(() => window.dispatchEvent(new Event("alook:safe-area-change")))
    expect(view.result.current).toBe(62)
    top = 0
    act(() => window.dispatchEvent(new Event("alook:safe-area-change")))
    expect(view.result.current).toBe(0)
  })

  it("reads iOS on mount and ignores an older reply after a newer layout update", async () => {
    const replies: Array<(value: number) => void> = []
    const postMessage = vi.fn(() => new Promise<number>((resolve) => replies.push(resolve)))
    setBridge("webkit", { messageHandlers: { alookSafeArea: { postMessage } } })
    const view = renderHook(useNativeSafeAreaTop)
    expect(postMessage).toHaveBeenCalledWith(null)
    expect(view.result.current).toBeNull()
    act(() => window.dispatchEvent(new Event("alook:safe-area-change")))
    await act(async () => { replies[1](62) })
    expect(view.result.current).toBe(62)
    await act(async () => { replies[0](0) })
    expect(view.result.current).toBe(62)

    view.unmount()
    act(() => window.dispatchEvent(new Event("alook:safe-area-change")))
    expect(postMessage).toHaveBeenCalledTimes(2)
  })

  it("keeps missing, rejected or unavailable insets distinct from zero", async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error("unavailable"))
    setBridge("webkit", { messageHandlers: { alookSafeArea: { postMessage } } })
    const ios = renderHook(useNativeSafeAreaTop)
    await waitFor(() => expect(postMessage).toHaveBeenCalledOnce())
    expect(ios.result.current).toBeNull()
    ios.unmount()

    setBridge("webkit", undefined)
    setBridge("AlookNative", { getSafeAreaTop: () => -1 })
    const android = renderHook(useNativeSafeAreaTop)
    expect(android.result.current).toBeNull()
    android.unmount()

    setBridge("AlookNative", undefined)
    expect(renderHook(useNativeSafeAreaTop).result.current).toBeNull()
  })

  it.each(["browser", "desktop"])("does not activate for a %s window", (mode) => {
    const getSafeAreaTop = vi.fn(() => 0)
    setBridge("AlookNative", { getSafeAreaTop })
    if (mode === "browser") Reflect.deleteProperty(window, "__TAURI__")
    else vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh")

    expect(renderHook(useNativeSafeAreaTop).result.current).toBeNull()
    expect(getSafeAreaTop).not.toHaveBeenCalled()
  })
})
