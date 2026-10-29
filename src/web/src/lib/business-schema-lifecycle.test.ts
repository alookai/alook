import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION } from "@alook/shared"
import { CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE } from "./service-worker/business-upgrade"
import { businessSchemaLifecycle, registerBusinessSchemaOwner, requestBusinessSchemaUpdate, retryBusinessSchemaUpdate } from "./business-schema-lifecycle"

beforeEach(() => businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION })))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe("business protocol retirement", () => {
  it("retires owners and stops after an already attempted document fails again", async () => {
    const replace = vi.fn()
    vi.stubGlobal("window", { location: { href: `https://alook.test/c/me?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}`, replace } })
    vi.stubGlobal("navigator", {})
    const retire = vi.fn().mockResolvedValue(undefined)
    const unregister = registerBusinessSchemaOwner(retire)
    try {
      expect(requestBusinessSchemaUpdate().name).toBe("BusinessSchemaMismatch")
      await vi.waitFor(() => expect(businessSchemaLifecycle.get().phase).toBe("failed"))
      requestBusinessSchemaUpdate()
      expect(retire).toHaveBeenCalledTimes(1)
      expect(replace).not.toHaveBeenCalled()
    } finally { unregister() }
  })

  it("bounds an unavailable worker and only retries on an explicit action", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("window", { location: { href: "https://alook.test/c/me" } })
    const getRegistration = vi.fn(() => new Promise<ServiceWorkerRegistration>(() => {}))
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } })
    requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(businessSchemaLifecycle.get()).toEqual({ phase: "failed", expectedVersion: BUSINESS_SCHEMA_VERSION + 1 })
    requestBusinessSchemaUpdate()
    expect(getRegistration).toHaveBeenCalledTimes(1)
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getRegistration).toHaveBeenCalledTimes(2)
    expect(businessSchemaLifecycle.get().phase).toBe("failed")
  })
  it("checks the new controller when it changes during the old version probe", async () => {
    vi.useFakeTimers()
    class FakeChannel {
      port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
      port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() }
    }
    vi.stubGlobal("MessageChannel", FakeChannel)
    vi.stubGlobal("window", { location: { href: "https://alook.test/c/me" } })
    let oldReply: { postMessage(data: unknown): void } | undefined
    const old = { postMessage: vi.fn((_message: unknown, ports: Array<{ postMessage(data: unknown): void }>) => { oldReply = ports[0] }) }
    const next = { postMessage: vi.fn((message: { type: string }, ports: Array<{ postMessage(data: unknown): void }>) => {
      if (message.type === WORKER_VERSION_PROBE) ports[0].postMessage({ schemaVersion: BUSINESS_SCHEMA_VERSION + 1 })
      if (message.type === CURRENT_DOCUMENT_REQUEST) ports[0].postMessage({ navigating: true })
    }) }
    const serviceWorker = Object.assign(new EventTarget(), { controller: old as typeof old | typeof next,
      getRegistration: vi.fn(async () => registration) })
    const registration = Object.assign(new EventTarget(), { update: vi.fn(async () => undefined), active: old, installing: null, waiting: null })
    vi.stubGlobal("navigator", { serviceWorker })
    requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(oldReply).toBeDefined()
    serviceWorker.controller = next
    serviceWorker.dispatchEvent(new Event("controllerchange"))
    oldReply!.postMessage({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    await vi.advanceTimersByTimeAsync(0)
    expect(next.postMessage.mock.calls.map(call => call[0].type)).toEqual([WORKER_VERSION_PROBE, CURRENT_DOCUMENT_REQUEST])
    expect(vi.getTimerCount()).toBe(0)
  })

})

it.each(["normal", "storage-denied", "public-path"])("bounds the no-worker document fallback: %s", async mode => {
  const replace = vi.fn()
  vi.stubGlobal("window", { location: { href: mode === "public-path" ? "https://alook.test/blog" : "https://alook.test/c/me", replace } })
  vi.stubGlobal("navigator", {})
  const stored = new Map<string, string>()
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => { if (mode === "storage-denied") throw new Error("denied"); return stored.get(key) ?? null }, setItem: (key: string, value: string) => { if (mode === "storage-denied") throw new Error("denied"); stored.set(key, value) } })
  requestBusinessSchemaUpdate()
  if (mode === "public-path") await vi.waitFor(() => expect(businessSchemaLifecycle.get().phase).toBe("failed"))
  else await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(`https://alook.test/c/me?__alook_schema_update=${BUSINESS_SCHEMA_VERSION}`))
  if (mode === "normal") expect(stored.get("alook:business-schema-update-attempt")).toBe(String(BUSINESS_SCHEMA_VERSION))
  if (mode === "public-path") expect(replace).not.toHaveBeenCalled()
})

it("fails when a current worker explicitly refuses navigation and closes both reply ports", async () => {
  vi.useFakeTimers()
  const closed: ReturnType<typeof vi.fn>[] = []
  class Channel {
    port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
    port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() }
    constructor() { closed.push(this.port1.close, this.port2.close) }
  }
  const worker = { postMessage: (message: { type: string }, ports: Array<{ postMessage(data: unknown): void }>) => ports[0]!.postMessage(message.type === WORKER_VERSION_PROBE ? { schemaVersion: BUSINESS_SCHEMA_VERSION + 1 } : { navigating: false }) }
  vi.stubGlobal("MessageChannel", Channel)
  vi.stubGlobal("window", { location: { href: "https://alook.test/c/me" } })
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() })
  const registration = Object.assign(new EventTarget(), { update: vi.fn(async () => {}), active: worker, waiting: null, installing: null })
  vi.stubGlobal("navigator", { serviceWorker: Object.assign(new EventTarget(), { controller: worker, getRegistration: vi.fn(async () => registration) }) })
  requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(businessSchemaLifecycle.get()).toEqual({ phase: "failed", expectedVersion: BUSINESS_SCHEMA_VERSION + 1 })
  expect(closed.length).toBeGreaterThan(0)
  expect(closed.every(close => close.mock.calls.length > 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
