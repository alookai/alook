import { afterEach, describe, expect, it, vi } from "vitest"
import { listenNativeWindowLifecycle } from "./native-window-lifecycle"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("native window lifecycle", () => {
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
