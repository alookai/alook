import { afterEach, describe, expect, it, vi } from "vitest"
import { listenNativeWindowLifecycle } from "./native-window-lifecycle"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("native window lifecycle", () => {
  it("returns a usable cleanup when the native current window lookup throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => { throw new Error("window unavailable") } } } })
    const dispose = listenNativeWindowLifecycle(handlers)
    expect(() => { dispose(); dispose() }).not.toThrow()
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle window unavailable")
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
  })

  it.each(["sync", "async"] as const)("releases the sibling and retires callbacks when %s cleanup fails", async (failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const callbacks = new Map<string, () => void>()
    const error = new Error("cleanup failed")
    const failedRelease = vi.fn(() => { if (failure === "sync") throw error; return Promise.reject(error) })
    const siblingRelease = vi.fn()
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({
      listen: async (event: string, callback: () => void) => {
        callbacks.set(event, callback)
        return event === "tauri://resumed" ? failedRelease : siblingRelease
      },
    }) } } })
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    const dispose = listenNativeWindowLifecycle(handlers)
    await Promise.resolve()
    expect(() => { dispose(); dispose() }).not.toThrow()
    await Promise.resolve()
    expect(failedRelease).toHaveBeenCalledOnce()
    expect(siblingRelease).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle cleanup failed")
    callbacks.get("tauri://resumed")!()
    callbacks.get("tauri://suspended")!()
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
  })

  it("isolates a throwing callback while keeping the sibling and cleanup usable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const callbacks = new Map<string, () => void>()
    const release = vi.fn()
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({
      listen: async (event: string, callback: () => void) => { callbacks.set(event, callback); return release },
    }) } } })
    const handlers = { resumed: vi.fn(() => { throw new Error("consumer failed") }), suspended: vi.fn() }
    const dispose = listenNativeWindowLifecycle(handlers)
    await Promise.resolve()
    expect(() => callbacks.get("tauri://resumed")!()).not.toThrow()
    callbacks.get("tauri://suspended")!()
    expect(handlers.resumed).toHaveBeenCalledOnce()
    expect(handlers.suspended).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle callback failed", { event: "resumed" })
    dispose()
    expect(release).toHaveBeenCalledTimes(2)
  })

  it.each(["resumed", "suspended"] as const)("retires the group when %s registration throws synchronously", async (failed) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const callbacks = new Map<string, () => void>()
    const releases: Array<(unlisten: () => void) => void> = []
    const release = vi.fn()
    const listen = vi.fn((event: string, callback: () => void) => {
      if (event === `tauri://${failed}`) throw new Error("registration failed")
      callbacks.set(event, callback)
      return new Promise<() => void>((resolve) => releases.push(resolve))
    })
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({ listen }) } } })
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    const dispose = listenNativeWindowLifecycle(handlers)
    for (const resolve of releases) resolve(release)
    await Promise.resolve()
    for (const callback of callbacks.values()) callback()
    dispose()
    expect(listen).toHaveBeenCalledTimes(failed === "resumed" ? 1 : 2)
    expect(release).toHaveBeenCalledTimes(failed === "resumed" ? 0 : 1)
    expect(warn).toHaveBeenCalledExactlyOnceWith("[ws] native lifecycle listener unavailable", { event: failed })
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
  })

  it("uses the current window, retires handlers immediately and releases late registrations", async () => {
    const listeners = new Map<string, () => void>()
    const releases = [vi.fn(), vi.fn()]
    const registrations: Array<(value: () => void) => void> = []
    const listen = vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler)
      return new Promise<() => void>((resolve) => registrations.push(resolve))
    })
    const getCurrentWindow = vi.fn(() => ({ listen }))
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow } } })
    const resumed = vi.fn(), suspended = vi.fn()
    const dispose = listenNativeWindowLifecycle({ resumed, suspended })
    expect(getCurrentWindow).toHaveBeenCalledOnce()
    expect([...listeners.keys()]).toEqual(["tauri://resumed", "tauri://suspended"])
    listeners.get("tauri://suspended")!()
    listeners.get("tauri://resumed")!()
    expect(resumed).not.toHaveBeenCalled()
    expect(suspended).not.toHaveBeenCalled()
    registrations[0](releases[0])
    await Promise.resolve()
    dispose()
    registrations[1](releases[1])
    await Promise.resolve()
    listeners.get("tauri://resumed")!()
    listeners.get("tauri://suspended")!()
    expect(resumed).not.toHaveBeenCalled()
    expect(suspended).not.toHaveBeenCalled()
    for (const release of releases) expect(release).toHaveBeenCalledOnce()
  })

  it("keeps Web and failed native registrations usable without an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    vi.stubGlobal("window", {})
    listenNativeWindowLifecycle(handlers)()
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({
      listen: vi.fn().mockRejectedValue(new Error("permission denied")),
    }) } } })
    const dispose = listenNativeWindowLifecycle(handlers)
    await Promise.resolve()
    await Promise.resolve()
    dispose()
    expect(warn).toHaveBeenCalledOnce()
    expect(handlers.resumed).not.toHaveBeenCalled()
  })

  it("activates both registrations together and delivers only the latest buffered state", async () => {
    const callbacks = new Map<string, () => void>()
    const registrations: Array<(value: () => void) => void> = []
    const release = vi.fn()
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({
      listen: (event: string, callback: () => void) => {
        callbacks.set(event, callback)
        return new Promise<() => void>((resolve) => registrations.push(resolve))
      },
    }) } } })
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    const dispose = listenNativeWindowLifecycle(handlers)
    registrations[1](release)
    await Promise.resolve()
    callbacks.get("tauri://suspended")!()
    callbacks.get("tauri://resumed")!()
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
    registrations[0](release)
    await Promise.resolve()
    expect(handlers.resumed).toHaveBeenCalledOnce()
    expect(handlers.suspended).not.toHaveBeenCalled()
    callbacks.get("tauri://suspended")!()
    expect(handlers.suspended).toHaveBeenCalledOnce()
    dispose()
    expect(release).toHaveBeenCalledTimes(2)
  })
  it.each([
    ["resumed", "before"], ["resumed", "after"], ["suspended", "before"], ["suspended", "after"],
  ] as const)("retires the whole group when %s fails with its sibling resolving %s failure", async (failed, order) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const callbacks = new Map<string, () => void>()
    const registrations = new Map<string, { resolve: (value: () => void) => void; reject: (error: Error) => void }>()
    const release = vi.fn()
    vi.stubGlobal("window", { __TAURI__: { window: { getCurrentWindow: () => ({
      listen: (name: string, callback: () => void) => {
        callbacks.set(name, callback)
        return new Promise<() => void>((resolve, reject) => { registrations.set(name, { resolve, reject }) })
      },
    }) } } })
    const handlers = { resumed: vi.fn(), suspended: vi.fn() }
    const dispose = listenNativeWindowLifecycle(handlers)
    const sibling = failed === "resumed" ? "suspended" : "resumed"
    if (order === "before") {
      registrations.get(`tauri://${sibling}`)!.resolve(release)
      await Promise.resolve()
    }
    callbacks.get("tauri://suspended")!()
    expect(handlers.suspended).not.toHaveBeenCalled()
    registrations.get(`tauri://${failed}`)!.reject(new Error("registration denied"))
    await Promise.resolve()
    await Promise.resolve()
    if (order === "after") {
      registrations.get(`tauri://${sibling}`)!.resolve(release)
      await Promise.resolve()
    }
    callbacks.get("tauri://resumed")!()
    callbacks.get("tauri://suspended")!()
    dispose()
    expect(handlers.resumed).not.toHaveBeenCalled()
    expect(handlers.suspended).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

})
