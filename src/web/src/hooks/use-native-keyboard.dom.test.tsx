import { afterEach, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { registerNativeKeyboardSettle, useNativeKeyboard, type KeyboardSettleEvent, type OverlayGpuKeyboardPacket } from "./use-native-keyboard"

const originalAndroid = Object.getOwnPropertyDescriptor(window, "__alookNativeBridge")
const original = Object.getOwnPropertyDescriptor(window, "webkit")
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__")
afterEach(() => {
  vi.useRealTimers()
  document.documentElement.style.removeProperty("--alook-keyboard-progress")
  document.documentElement.style.removeProperty("--alook-keyboard-bottom")
  document.documentElement.style.removeProperty("--alook-kb-translate-y")
  document.documentElement.style.removeProperty("--alook-kb-transition")
  document.documentElement.style.removeProperty("--app-safe-area-bottom")
  document.documentElement.removeAttribute("data-alook-kb-animating")
  if (originalAndroid) Object.defineProperty(window, "__alookNativeBridge", originalAndroid)
  else Reflect.deleteProperty(window, "__alookNativeBridge")
  if (original) Object.defineProperty(window, "webkit", original)
  else Reflect.deleteProperty(window, "webkit")
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri)
  else Reflect.deleteProperty(window, "__TAURI__")
})

function snapshot(bottomInset = 0, viewportWidth = window.innerWidth) { return { bottomInset, viewportWidth } }

function install(postMessage: (command: "snapshot") => Promise<unknown>) {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "webkit", {
    configurable: true, value: { messageHandlers: { alookKeyboard: { postMessage } } },
  })
}

it("keeps ordinary Web and Android without a native keyboard capability unchanged", () => {
  Reflect.deleteProperty(window, "webkit")
  const view = renderHook(useNativeKeyboard)
  expect(view.result.current).toBeNull()
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  expect(view.result.current).toBeNull()
})

it("does not enable native layout in a browser with a WebKit-shaped object", async () => {
  const post = vi.fn(async () => snapshot(300))
  install(post)
  Reflect.deleteProperty(window, "__TAURI__")
  const view = renderHook(useNativeKeyboard)
  await act(async () => {})
  expect(view.result.current).toBeNull()
  expect(post).not.toHaveBeenCalled()
})

it("updates overlap for closed and reopened keyboard snapshots", async () => {
  let bottomInset = 300
  const post = vi.fn(async () => snapshot(bottomInset))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current).toEqual(snapshot(300)))
  bottomInset = 0
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current).toEqual(snapshot()))
  bottomInset = 320
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current).toEqual(snapshot(320)))
  expect(post).toHaveBeenLastCalledWith("snapshot")
  expect(post).toHaveBeenCalledTimes(3)
})

it("does not let an older native snapshot revive a later closed state", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const post = vi.fn().mockImplementationOnce(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }))
    .mockResolvedValue(snapshot())
  install(post)
  const view = renderHook(useNativeKeyboard)
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await act(async () => release(snapshot(300)))
  expect(view.result.current).toEqual(snapshot())
  expect(post).toHaveBeenCalledTimes(2)
})

it("retires pending snapshots and callbacks when a component leaves", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const oldPost = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }))
  install(oldPost)
  const old = renderHook(useNativeKeyboard)
  old.unmount()
  const nextPost = vi.fn(async () => snapshot())
  install(nextPost)
  const next = renderHook(useNativeKeyboard)
  await act(async () => release(snapshot(300)))
  expect(oldPost).toHaveBeenCalledTimes(1)
  expect(nextPost).toHaveBeenCalledExactlyOnceWith("snapshot")
  expect(next.result.current).toEqual(snapshot())
})

it("retires on pagehide and resumes only the preserved document on BFCache return", async () => {
  const post = vi.fn(async () => snapshot(300))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current).toEqual(snapshot(300)))
  act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  const calls = post.mock.calls.length
  act(() => {
    window.dispatchEvent(new Event("alook:keyboard-change"))
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }))
  })
  expect(post).toHaveBeenCalledTimes(calls)
  expect(view.result.current).toBeNull()
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  await waitFor(() => expect(view.result.current).toEqual(snapshot(300)))
})

it("keeps failed capability reads closed and accepts a later native state change", async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(snapshot(300))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await act(async () => {})
  expect(view.result.current).toBeNull()
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current).toEqual(snapshot(300)))
})


it("keeps native geometry intact and resamples on the existing resize event", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
  const post = vi.fn(async () => snapshot(150, 450))
  install(post)
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current).toEqual(snapshot(150, 450)))
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 450 })
    act(() => window.dispatchEvent(new Event("resize")))
    await waitFor(() => expect(view.result.current).toEqual(snapshot(150, 450)))
    expect(post).toHaveBeenCalledTimes(2)
  } finally {
    view.unmount()
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth)
  }
})

it("keeps native geometry independent of CSS width without a manual rerender", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 382 })
  const post = vi.fn(async () => snapshot(244, 867))
  install(post)
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current).toEqual(snapshot(244, 867)))
    const native = view.result.current
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 867 })
    expect(view.result.current).toBe(native)
    expect(post).toHaveBeenCalledTimes(1)
  } finally {
    view.unmount()
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth)
  }
})

it.each([true, false, { bottomInset: -10, viewportWidth: 390 }, { bottomInset: 100, viewportWidth: 0 },
  { bottomInset: Number.NaN, viewportWidth: 390 }, { bottomInset: 100, viewportWidth: Number.POSITIVE_INFINITY }])(
  "does not use malformed or retired-format native geometry: %j", async (value) => {
    install(async () => value)
    const view = renderHook(useNativeKeyboard)
    await act(async () => {})
    expect(view.result.current).toBeNull()
  },
)

it("uses pushed native animation frames without bridge round trips or a React commit per frame", async () => {
  const post = vi.fn(async () => snapshot())
  install(post)
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current).toEqual(snapshot()))
  const push = (bottomInset: number, isAnimating: boolean) => window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
    detail: { ...snapshot(bottomInset, 400), isAnimating },
  }))
  act(() => push(10, true))
  const frame = view.result.current
  act(() => { push(120, true); window.dispatchEvent(new Event("resize")) })
  expect(view.result.current).toBe(frame)
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`max(0px, calc(30vw - var(--app-safe-area-bottom)))`)
  expect(post).toHaveBeenCalledTimes(1)
  act(() => push(300, false))
  expect(view.result.current).toEqual(snapshot(300, 400))
  act(() => push(0, false))
  expect(view.result.current).toEqual(snapshot(0, 400))
})


it("accepts animation before the initial snapshot and ignores its late reply", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const post = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }))
  install(post)
  const view = renderHook(useNativeKeyboard)
  expect(view.result.current).toBeNull()
  const push = (bottomInset: number, isAnimating: boolean) => window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
    detail: { ...snapshot(bottomInset, 400), isAnimating },
  }))

  act(() => push(40, true))
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`max(0px, calc(10vw - var(--app-safe-area-bottom)))`)
  expect(view.result.current).toEqual(snapshot(0, 400))
  const initialFrame = view.result.current
  act(() => { push(160, true); window.dispatchEvent(new Event("resize")) })
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`max(0px, calc(40vw - var(--app-safe-area-bottom)))`)
  expect(view.result.current).toBe(initialFrame)
  expect(post).toHaveBeenCalledExactlyOnceWith("snapshot")

  act(() => push(300, false))
  expect(view.result.current).toEqual(snapshot(300, 400))
  const finalFrame = view.result.current
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`max(0px, calc(75vw - var(--app-safe-area-bottom)))`)
  await act(async () => release(snapshot(0, 800)))
  expect(view.result.current).toBe(finalFrame)
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe(`max(0px, calc(75vw - var(--app-safe-area-bottom)))`)
  expect(post).toHaveBeenCalledTimes(1)
})

it("reads Android's current atomic keyboard packet and applies the same overlap owner", async () => {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  let next = snapshot(300, 1000)
  const query = vi.fn(() => next)
  Object.defineProperty(window, "__alookNativeBridge", { configurable: true, value: { getKeyboardSnapshot: query } })
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current).toEqual(snapshot(300, 1000)))
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress"))
    .toBe("max(0px, calc(30vw - var(--app-safe-area-bottom)))")
  next = snapshot(0, 1000)
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current).toEqual(snapshot(0, 1000)))
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
})

it("shares one document listener/query owner and keeps projection alive for the remaining consumer", async () => {
  const post = vi.fn(async () => snapshot(300, 1000))
  install(post)
  const root = renderHook(useNativeKeyboard)
  const footer = renderHook(useNativeKeyboard)
  await waitFor(() => expect(footer.result.current).toEqual(snapshot(300, 1000)))
  expect(post).toHaveBeenCalledOnce()
  root.unmount()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("30vw")
  expect(footer.result.current).toEqual(snapshot(300, 1000))
  footer.unmount()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("")
})


it.each(["ios", "android"])("lets the %s native viewport own keyboard height without Web projection or resize queries", async platform => {
  const read = vi.fn(async () => ({ resizesViewport: true }))
  install(read)
  const android = vi.fn(() => ({ resizesViewport: true }))
  if (platform === "android") Object.defineProperty(window, "__alookNativeBridge", { configurable: true, value: { getKeyboardSnapshot: android } })
  document.documentElement.style.setProperty("--alook-keyboard-bottom", "60vw")
  document.documentElement.style.setProperty("--alook-keyboard-progress", "50vw")
  const view = renderHook(useNativeKeyboard)
  await act(async () => {})
  expect(view.result.current).toBeNull()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("")
  act(() => {
    window.dispatchEvent(new Event("resize"))
    window.dispatchEvent(new Event("alook:geometry-change"))
    window.dispatchEvent(new CustomEvent("alook:keyboard-change", { detail: { ...snapshot(300), isAnimating: true } }))
  })
  expect(view.result.current).toBeNull()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("")
  expect(platform === "android" ? android : read).toHaveBeenCalledTimes(1)
  act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  await act(async () => {})
  expect(platform === "android" ? android : read).toHaveBeenCalledTimes(2)
  expect(view.result.current).toBeNull()
})

it("does not let a pending legacy read restore compensation after resize capability arrives", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const post = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue({ resizesViewport: true })
  install(post)
  const view = renderHook(useNativeKeyboard)
  act(() => window.dispatchEvent(new Event("alook:geometry-change")))
  await act(async () => {})
  await act(async () => release(snapshot(300)))
  expect(view.result.current).toBeNull()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("")
})


it("gives native resize capability priority over an earlier legacy animation event", async () => {
  let release!: (value: { resizesViewport: true }) => void
  install(() => new Promise(resolve => { release = resolve }))
  const view = renderHook(useNativeKeyboard)
  act(() => window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
    detail: { ...snapshot(300), isAnimating: true },
  })))
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).not.toBe("")
  await act(async () => release({ resizesViewport: true }))
  expect(view.result.current).toBeNull()
  expect(document.documentElement.style.getPropertyValue("--alook-keyboard-bottom")).toBe("")
})

it("ignores retired global AlookNative bridge objects", async () => {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  const legacy = vi.fn(() => JSON.stringify(snapshot(300, 1000)))
  Object.defineProperty(window, "AlookNative", { configurable: true, value: { getKeyboardSnapshot: legacy } })
  try {
    const view = renderHook(useNativeKeyboard)
    await act(async () => {})
    expect(view.result.current).toBeNull()
    expect(legacy).not.toHaveBeenCalled()
  } finally {
    Reflect.deleteProperty(window, "AlookNative")
  }
})

function overlayPacket(overrides: Partial<OverlayGpuKeyboardPacket> = {}): OverlayGpuKeyboardPacket {
  return {
    mode: "overlay-gpu",
    targetInset: 0,
    viewportWidth: 400,
    durationMs: 0,
    easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    phase: "settled",
    sequence: 0,
    ...overrides,
  }
}

it("glides with GPU CSS variables at t=0 on expand and uses t=0 FLIP on dismiss without top gap", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 })
  document.documentElement.style.setProperty("--app-safe-area-bottom", "34px")
  const post = vi.fn(async () => overlayPacket({ sequence: 0 }))
  install(post)
  const settles: KeyboardSettleEvent[] = []
  let flipStartSnapshot: { translateY: string; transition: string; layoutProgress: string; visualProgress: string } | null = null
  const unregister = registerNativeKeyboardSettle((event) => {
    settles.push(event)
    if (event.deltaInsetPx < 0) {
      flipStartSnapshot = {
        translateY: document.documentElement.style.getPropertyValue("--alook-kb-translate-y"),
        transition: document.documentElement.style.getPropertyValue("--alook-kb-transition"),
        layoutProgress: document.documentElement.style.getPropertyValue("--alook-kb-layout-progress"),
        visualProgress: document.documentElement.style.getPropertyValue("--alook-kb-visual-progress"),
      }
    }
  })
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current).toEqual({ bottomInset: 0, viewportWidth: 400, mode: "overlay-gpu" }))
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 334, durationMs: 250, phase: "animating", sequence: 1 }),
      }))
    })
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBe("true")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("-300px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-layout-progress")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-visual-progress")).toBe("300px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-transition"))
      .toBe("transform 250ms cubic-bezier(0.32, 0.72, 0, 1)")
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
    expect(settles).toEqual([])

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 334, durationMs: 0, phase: "settled", sequence: 2 }),
      }))
    })
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBeNull()
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-layout-progress")).toBe("300px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-visual-progress")).toBe("300px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-transition")).toBe("none")
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress"))
      .toBe(`max(0px, calc(${334 / 400 * 100}vw - var(--app-safe-area-bottom)))`)
    expect(settles).toEqual([{ previousInsetPx: 0, nextInsetPx: 300, deltaInsetPx: 300, sequence: 2 }])
    expect(view.result.current).toEqual({ bottomInset: 334, viewportWidth: 400, mode: "overlay-gpu" })

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 0, durationMs: 220, phase: "animating", sequence: 3 }),
      }))
    })
    expect(flipStartSnapshot).toEqual({
      translateY: "-300px",
      transition: "none",
      layoutProgress: "0px",
      visualProgress: "300px",
    })
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBe("true")
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-layout-progress")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-visual-progress")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-transition"))
      .toBe("transform 220ms cubic-bezier(0.32, 0.72, 0, 1)")
    expect(settles).toEqual([
      { previousInsetPx: 0, nextInsetPx: 300, deltaInsetPx: 300, sequence: 2 },
      { previousInsetPx: 300, nextInsetPx: 0, deltaInsetPx: -300, sequence: 3 },
    ])

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 0, durationMs: 0, phase: "settled", sequence: 4 }),
      }))
    })
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBeNull()
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
    expect(settles).toHaveLength(2)
    expect(view.result.current).toEqual({ bottomInset: 0, viewportWidth: 400, mode: "overlay-gpu" })
  } finally {
    unregister()
    view.unmount()
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth)
  }
})

it("handles mid-dismiss re-open, mid-expand shrink FLIP, transitionend dedupe, out-of-order sequences, and safety timer settle", async () => {
  vi.useFakeTimers()
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 })
  install(async () => overlayPacket({ sequence: 0 }))
  const settles: KeyboardSettleEvent[] = []
  let lastFlipStartTranslateY = ""
  const unregister = registerNativeKeyboardSettle((event) => {
    settles.push(event)
    if (event.deltaInsetPx < 0) {
      lastFlipStartTranslateY = document.documentElement.style.getPropertyValue("--alook-kb-translate-y")
    }
  })
  const view = renderHook(useNativeKeyboard)
  const layer = document.createElement("div")
  layer.setAttribute("data-alook-kb-gpu-layer", "true")
  document.body.appendChild(layer)
  try {
    await act(async () => { await Promise.resolve() })

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 300, durationMs: 250, phase: "animating", sequence: 1 }),
      }))
    })
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("-300px")

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 0, durationMs: 200, phase: "animating", sequence: 2 }),
      }))
    })
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("0px")
    expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 280, durationMs: 250, phase: "animating", sequence: 3 }),
      }))
    })
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("-280px")

    act(() => {
      const event = new Event("transitionend", { bubbles: true })
      Object.defineProperty(event, "propertyName", { value: "transform" })
      layer.dispatchEvent(event)
    })
    expect(settles).toEqual([{ previousInsetPx: 0, nextInsetPx: 280, deltaInsetPx: 280, sequence: 3 }])
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBeNull()

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 280, durationMs: 0, phase: "settled", sequence: 4 }),
      }))
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 0, durationMs: 0, phase: "settled", sequence: 2 }),
      }))
    })
    expect(settles).toHaveLength(1)
    expect(view.result.current).toEqual({ bottomInset: 280, viewportWidth: 400, mode: "overlay-gpu" })

    // Dismiss via FLIP (commits layout 0 immediately), then interrupt mid-dismiss by re-opening to 280
    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 0, durationMs: 200, phase: "animating", sequence: 5 }),
      }))
    })
    expect(lastFlipStartTranslateY).toBe("-280px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("0px")
    expect(settles).toHaveLength(2)

    act(() => {
      window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
        detail: overlayPacket({ targetInset: 280, durationMs: 220, phase: "animating", sequence: 6 }),
      }))
    })
    expect(document.documentElement.style.getPropertyValue("--alook-kb-translate-y")).toBe("-280px")
    expect(document.documentElement.style.getPropertyValue("--alook-kb-visual-progress")).toBe("280px")

    act(() => { vi.advanceTimersByTime(340) })
    expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBeNull()
    expect(settles).toEqual([
      { previousInsetPx: 0, nextInsetPx: 280, deltaInsetPx: 280, sequence: 3 },
      { previousInsetPx: 280, nextInsetPx: 0, deltaInsetPx: -280, sequence: 5 },
      { previousInsetPx: 0, nextInsetPx: 280, deltaInsetPx: 280, sequence: 6 },
    ])

    // Mid-expand from 280 -> 340 interrupted to 0 uses live computed translateY (-40px -> -320px FLIP start)
    const computedSpy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      transform: "matrix(1, 0, 0, 1, 0, -40)",
      getPropertyValue: () => "",
    } as unknown as CSSStyleDeclaration)
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
          detail: overlayPacket({ targetInset: 340, durationMs: 200, phase: "animating", sequence: 7 }),
        }))
      })
      act(() => {
        window.dispatchEvent(new CustomEvent("alook:keyboard-change", {
          detail: overlayPacket({ targetInset: 0, durationMs: 200, phase: "animating", sequence: 8 }),
        }))
      })
      expect(lastFlipStartTranslateY).toBe("-320px")
      act(() => { vi.advanceTimersByTime(320) })
      expect(document.documentElement.getAttribute("data-alook-kb-animating")).toBeNull()
      expect(document.documentElement.style.getPropertyValue("--alook-keyboard-progress")).toBe("")
      expect(settles).toEqual([
        { previousInsetPx: 0, nextInsetPx: 280, deltaInsetPx: 280, sequence: 3 },
        { previousInsetPx: 280, nextInsetPx: 0, deltaInsetPx: -280, sequence: 5 },
        { previousInsetPx: 0, nextInsetPx: 280, deltaInsetPx: 280, sequence: 6 },
        { previousInsetPx: 280, nextInsetPx: 0, deltaInsetPx: -280, sequence: 8 },
      ])
    } finally {
      computedSpy.mockRestore()
    }
  } finally {
    layer.remove()
    unregister()
    view.unmount()
    if (originalWidth) Object.defineProperty(window, "innerWidth", originalWidth)
  }
})
