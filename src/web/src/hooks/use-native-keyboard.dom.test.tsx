import { afterEach, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { useNativeKeyboard } from "./use-native-keyboard"

const original = Object.getOwnPropertyDescriptor(window, "webkit")
const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__")
afterEach(() => {
  if (original) Object.defineProperty(window, "webkit", original)
  else Reflect.deleteProperty(window, "webkit")
  if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri)
  else Reflect.deleteProperty(window, "__TAURI__")
})

function snapshot(bottomInset = 0, viewportWidth = window.innerWidth) { return { bottomInset, viewportWidth } }

function install(postMessage: (command: "snapshot" | "dismiss") => Promise<unknown>) {
  Object.defineProperty(window, "__TAURI__", { configurable: true, value: {} })
  Object.defineProperty(window, "webkit", {
    configurable: true, value: { messageHandlers: { alookKeyboard: { postMessage } } },
  })
}

it("keeps ordinary Web and Android without a native keyboard capability unchanged", () => {
  Reflect.deleteProperty(window, "webkit")
  const view = renderHook(useNativeKeyboard)
  expect(view.result.current.visible).toBe(false)
  act(() => view.result.current.dismiss())
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  expect(view.result.current.visible).toBe(false)
})

it("does not enable native layout in a browser with a WebKit-shaped object", async () => {
  const post = vi.fn(async () => snapshot(300))
  install(post)
  Reflect.deleteProperty(window, "__TAURI__")
  const view = renderHook(useNativeKeyboard)
  await act(async () => {})
  expect(view.result.current.bottomInset).toBe(0)
  expect(view.result.current.visible).toBe(false)
  expect(post).not.toHaveBeenCalled()
})

it("reads current visibility and waits for native layout confirmation after explicit dismissal", async () => {
  let visible = true
  const post = vi.fn(async () => snapshot(visible ? 300 : 0))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current.visible).toBe(true))
  act(() => view.result.current.dismiss())
  expect(post).toHaveBeenLastCalledWith("dismiss")
  expect(view.result.current.visible).toBe(true)
  visible = false
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current.visible).toBe(false))
})

it("does not let an older native snapshot revive a later closed state", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const post = vi.fn().mockImplementationOnce(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }))
    .mockResolvedValue(snapshot())
  install(post)
  const view = renderHook(useNativeKeyboard)
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await act(async () => release(snapshot(300)))
  expect(view.result.current.visible).toBe(false)
  expect(post).toHaveBeenCalledTimes(2)
})

it("retires pending snapshots and callbacks when a component leaves", async () => {
  let release!: (value: ReturnType<typeof snapshot>) => void
  const oldPost = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve }))
  install(oldPost)
  const old = renderHook(useNativeKeyboard)
  const dismiss = old.result.current.dismiss
  old.unmount()
  const nextPost = vi.fn(async () => snapshot())
  install(nextPost)
  const next = renderHook(useNativeKeyboard)
  await act(async () => release(snapshot(300)))
  act(() => dismiss())
  expect(oldPost).toHaveBeenCalledTimes(1)
  expect(nextPost).toHaveBeenCalledExactlyOnceWith("snapshot")
  expect(next.result.current.visible).toBe(false)
})

it("retires on pagehide and resumes only the preserved document on BFCache return", async () => {
  const post = vi.fn(async () => snapshot(300))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await waitFor(() => expect(view.result.current.visible).toBe(true))
  act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
  const calls = post.mock.calls.length
  act(() => {
    view.result.current.dismiss()
    window.dispatchEvent(new Event("alook:keyboard-change"))
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }))
  })
  expect(post).toHaveBeenCalledTimes(calls)
  expect(view.result.current.visible).toBe(false)
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
  await waitFor(() => expect(view.result.current.visible).toBe(true))
})

it("keeps failed capability reads closed and accepts a later native state change", async () => {
  const post = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(snapshot(300))
  install(post)
  const view = renderHook(useNativeKeyboard)
  await act(async () => {})
  expect(view.result.current.visible).toBe(false)
  act(() => window.dispatchEvent(new Event("alook:keyboard-change")))
  await waitFor(() => expect(view.result.current.visible).toBe(true))
})

it("reports a current dismissal failure while preserving the available retry control", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const post = vi.fn((command: "snapshot" | "dismiss") => command === "snapshot"
    ? Promise.resolve(snapshot(300)) : Promise.reject(new Error("rejected")))
  install(post)
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current.visible).toBe(true))
    await act(async () => view.result.current.dismiss())
    expect(error).toHaveBeenCalledExactlyOnceWith("Native keyboard dismissal failed")
    expect(view.result.current.visible).toBe(true)
  } finally { error.mockRestore() }
})

it("does not report an old dismissal failure after the component retires", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  let reject!: (error: Error) => void
  install(command => command === "snapshot" ? Promise.resolve(snapshot(300))
    : new Promise<ReturnType<typeof snapshot>>((_resolve, fail) => { reject = fail }))
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current.visible).toBe(true))
    act(() => view.result.current.dismiss())
    view.unmount()
    await act(async () => reject(new Error("retired")))
    expect(error).not.toHaveBeenCalled()
  } finally { error.mockRestore() }
})


it("converts native overlap points to the current CSS width and resamples on resize", async () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
  const post = vi.fn(async () => snapshot(150, 450))
  install(post)
  const view = renderHook(useNativeKeyboard)
  try {
    await waitFor(() => expect(view.result.current.bottomInset).toBe(300))
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 450 })
    act(() => window.dispatchEvent(new Event("resize")))
    await waitFor(() => expect(view.result.current.bottomInset).toBe(150))
    expect(post).toHaveBeenCalledTimes(2)
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
    expect(view.result.current.bottomInset).toBe(0)
    expect(view.result.current.visible).toBe(false)
  },
)
