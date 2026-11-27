import { afterEach, describe, expect, it, vi } from "vitest"
import { listenNativeWindowLifecycle } from "./native-window-lifecycle"

type FakeChannel = { onmessage: (payload?: unknown) => void }

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function installMobileTauri(invoke: ReturnType<typeof vi.fn>) {
  const channels: FakeChannel[] = []
  class Channel implements FakeChannel {
    onmessage: (payload?: unknown) => void = () => undefined
    constructor() { channels.push(this) }
  }
  vi.stubGlobal("window", {
    __TAURI__: { core: { Channel, invoke } },
    __ALOOK_NATIVE_RUNTIME__: { formFactor: "mobile" },
  })
  return { channels, invoke }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("native window lifecycle", () => {
  it("stays silent on Web and Desktop Tauri without invoking mobile lifecycle commands", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const invoke = vi.fn()
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }

    vi.stubGlobal("window", {})
    listenNativeWindowLifecycle(handlers)()

    vi.stubGlobal("window", {
      __TAURI__: { core: { invoke } },
      __ALOOK_NATIVE_RUNTIME__: { formFactor: "desktop" },
    })
    listenNativeWindowLifecycle(handlers)()

    expect(invoke).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
  })

  it("returns a usable cleanup when the native Channel bridge is unavailable or throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    vi.stubGlobal("window", {
      __TAURI__: { core: { get Channel() { throw new Error("bridge unavailable") } } },
      __ALOOK_NATIVE_RUNTIME__: { formFactor: "mobile" },
    })
    const dispose = listenNativeWindowLifecycle(handlers)
    expect(() => { dispose(); dispose() }).not.toThrow()
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle bridge unavailable")
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
  })

  it("delivers initial suspended snapshot immediately and shares one channel across concurrent subscribers", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "window_lifecycle_listen") return { registrationId: 7, suspended: true }
      return undefined
    })
    const { channels } = installMobileTauri(invoke)
    const first = { resumed: vi.fn(), suspended: vi.fn() }
    const second = { resumed: vi.fn(), suspended: vi.fn() }

    const disposeFirst = listenNativeWindowLifecycle(first)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith("window_lifecycle_listen", { channel: channels[0] })
    expect(first.suspended).toHaveBeenCalledOnce()

    // Second subscriber joins while already suspended: receives snapshot immediately without re-listening.
    const disposeSecond = listenNativeWindowLifecycle(second)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(second.suspended).toHaveBeenCalledOnce()

    channels[0]!.onmessage("resumed")
    expect(first.resumed).toHaveBeenCalledOnce()
    expect(second.resumed).toHaveBeenCalledOnce()

    // Disposing first keeps channel alive for second.
    disposeFirst()
    expect(invoke).toHaveBeenCalledTimes(1)
    channels[0]!.onmessage("suspended")
    expect(first.suspended).toHaveBeenCalledOnce()
    expect(second.suspended).toHaveBeenCalledTimes(2)

    // Disposing last unregisters the Rust listener once.
    disposeSecond()
    disposeSecond()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith("window_lifecycle_unlisten", { registrationId: 7 })
  })

  it("buffers early events while connecting and delivers only the latest state once registered", async () => {
    let resolveListen!: (value: { registrationId: number; suspended: boolean }) => void
    const invoke = vi.fn((command: string) => {
      if (command === "window_lifecycle_listen") {
        return new Promise<{ registrationId: number; suspended: boolean }>((resolve) => {
          resolveListen = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    const { channels } = installMobileTauri(invoke)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }

    const dispose = listenNativeWindowLifecycle(handlers)
    channels[0]!.onmessage("suspended")
    channels[0]!.onmessage("resumed")
    expect(handlers.suspended).not.toHaveBeenCalled()
    expect(handlers.resumed).not.toHaveBeenCalled()

    resolveListen({ registrationId: 3, suspended: true })
    await flush()
    expect(handlers.resumed).toHaveBeenCalledOnce()
    expect(handlers.suspended).not.toHaveBeenCalled()

    channels[0]!.onmessage("suspended")
    expect(handlers.suspended).toHaveBeenCalledOnce()
    dispose()
    expect(invoke).toHaveBeenLastCalledWith("window_lifecycle_unlisten", { registrationId: 3 })
  })

  it("releases a late registration immediately if disposed before listen resolves", async () => {
    let resolveListen!: (value: { registrationId: number; suspended: boolean }) => void
    const invoke = vi.fn((command: string) => {
      if (command === "window_lifecycle_listen") {
        return new Promise<{ registrationId: number; suspended: boolean }>((resolve) => {
          resolveListen = resolve
        })
      }
      return Promise.resolve(undefined)
    })
    const { channels } = installMobileTauri(invoke)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }

    const dispose = listenNativeWindowLifecycle(handlers)
    dispose()
    resolveListen({ registrationId: 9, suspended: true })
    await flush()

    expect(invoke).toHaveBeenLastCalledWith("window_lifecycle_unlisten", { registrationId: 9 })
    channels[0]!.onmessage("suspended")
    channels[0]!.onmessage("resumed")
    expect(handlers.suspended).not.toHaveBeenCalled()
    expect(handlers.resumed).not.toHaveBeenCalled()
  })

  it("isolates throwing callbacks and failed unlisten without breaking siblings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const invoke = vi.fn(async (command: string) => {
      if (command === "window_lifecycle_listen") return { registrationId: 4, suspended: false }
      throw new Error("cleanup failed")
    })
    const { channels } = installMobileTauri(invoke)
    const throwing = { resumed: vi.fn(() => { throw new Error("boom") }), suspended: vi.fn() }
    const healthy = { resumed: vi.fn(), suspended: vi.fn() }

    const disposeThrowing = listenNativeWindowLifecycle(throwing)
    const disposeHealthy = listenNativeWindowLifecycle(healthy)
    await flush()

    expect(() => channels[0]!.onmessage("resumed")).not.toThrow()
    expect(throwing.resumed).toHaveBeenCalledOnce()
    expect(healthy.resumed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith("[ws] native lifecycle callback failed", { event: "resumed" })

    disposeThrowing()
    disposeHealthy()
    await flush()
    expect(warn).toHaveBeenCalledWith("[ws] native lifecycle cleanup failed")
  })

  it("retires cleanly on failed native listen registration without unhandled rejections", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const invoke = vi.fn().mockRejectedValue(new Error("untrusted_caller"))
    const { channels } = installMobileTauri(invoke)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }

    const dispose = listenNativeWindowLifecycle(handlers)
    await flush()

    channels[0]!.onmessage("suspended")
    dispose()
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle listener unavailable")
    expect(handlers.suspended).not.toHaveBeenCalled()
    expect(handlers.resumed).not.toHaveBeenCalled()
  })
})
