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

function workerFixture(version = BUSINESS_SCHEMA_VERSION as number) {
  const ports: Array<ReturnType<typeof vi.fn>> = []
  class Channel {
    port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
    port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() }
    constructor() { ports.push(this.port1.close, this.port2.close) }
  }
  const messages: Array<{ type: string; schemaVersion?: number }> = []
  const worker = { postMessage: (message: { type: string; schemaVersion?: number }, transfer: Array<{ postMessage(data: unknown): void }>) => {
    messages.push(message)
    if (message.type === WORKER_VERSION_PROBE) transfer[0].postMessage({ schemaVersion: version })
    if (message.type === CURRENT_DOCUMENT_REQUEST) transfer[0].postMessage({ navigating: true })
  } }
  const registration = Object.assign(new EventTarget(), { update: vi.fn(async () => {}), active: worker, waiting: null, installing: null })
  const serviceWorker = Object.assign(new EventTarget(), { controller: worker,
    getRegistration: vi.fn(async (): Promise<typeof registration | undefined> => registration),
    register: vi.fn(async () => registration) })
  vi.useFakeTimers()
  vi.stubGlobal("MessageChannel", Channel)
  vi.stubGlobal("window", { location: { href: "https://alook.test/c/me", replace: vi.fn() } })
  vi.stubGlobal("navigator", { serviceWorker })
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() })
  return { registration, serviceWorker, messages, ports, setVersion: (value: number) => { version = value } }
}

it("waits for required retirement past the old three-second cutoff before touching the worker", async () => {
  const h = workerFixture()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const retire = vi.fn(() => held), unregister = registerBusinessSchemaOwner(retire)
  try {
    requestBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(businessSchemaLifecycle.get().phase).toBe("updating")
    expect(h.serviceWorker.getRegistration).not.toHaveBeenCalled()
    expect(h.messages).toEqual([])
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([
      { type: CURRENT_DOCUMENT_REQUEST, schemaVersion: BUSINESS_SCHEMA_VERSION, explicitRetry: false },
    ])
    expect(retire).toHaveBeenCalledOnce()
    expect(h.ports.length).toBe(4)
    expect(h.ports.every(close => close.mock.calls.length > 0)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally { release(); unregister() }
})

it("stops on failed retirement and retries it without repeating successful or still-pending owners", async () => {
  const h = workerFixture()
  const complete = vi.fn(async () => {})
  const failed = vi.fn().mockRejectedValueOnce(new Error("IDB transaction failed")).mockResolvedValue(undefined)
  let release!: () => void, failHeld!: (error: Error) => void
  const held = new Promise<void>((resolve, reject) => { release = resolve; failHeld = reject })
  const pending = vi.fn(() => Promise.resolve()).mockImplementationOnce(() => held)
  const unregisters = [complete, failed, pending].map(registerBusinessSchemaOwner)
  try {
    requestBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(businessSchemaLifecycle.get().phase).toBe("failed")
    expect(h.serviceWorker.getRegistration).not.toHaveBeenCalled()
    unregisters[0]()
    unregisters[2]()
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(businessSchemaLifecycle.get().phase).toBe("updating")
    expect(complete).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledTimes(2)
    expect(pending).toHaveBeenCalledOnce()
    expect(h.messages).toEqual([])
    unregisters[1]()
    failHeld(new Error("Detached disk retirement failed"))
    await vi.advanceTimersByTimeAsync(0)
    expect(businessSchemaLifecycle.get().phase).toBe("failed")
    expect(h.messages).toEqual([])
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(complete).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledTimes(2)
    expect(pending).toHaveBeenCalledTimes(2)
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { release(); unregisters.forEach(unregister => unregister()) }
})

it("includes a newly registered owner before the final document request", async () => {
  const h = workerFixture()
  let releaseUpdate!: () => void, releaseOwner!: () => void
  const update = new Promise<void>(resolve => { releaseUpdate = resolve })
  const held = new Promise<void>(resolve => { releaseOwner = resolve })
  h.registration.update.mockImplementation(() => update)
  requestBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.registration.update).toHaveBeenCalledOnce()
  const retire = vi.fn(() => held), unregister = registerBusinessSchemaOwner(retire)
  try {
    releaseUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(retire).toHaveBeenCalledOnce()
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([])
    releaseOwner()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally { releaseUpdate(); releaseOwner(); unregister() }
})

it("records a later target without automatic retry and uses that target on explicit Retry", async () => {
  const h = workerFixture()
  h.registration.update.mockRejectedValueOnce(new Error("Update unavailable"))
  requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(businessSchemaLifecycle.get().phase).toBe("failed")
  requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 2)
  requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION)
  expect(businessSchemaLifecycle.get()).toEqual({ phase: "failed", expectedVersion: BUSINESS_SCHEMA_VERSION + 2 })
  expect(h.registration.update).toHaveBeenCalledOnce()
  h.setVersion(BUSINESS_SCHEMA_VERSION + 2)
  retryBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([
    { type: CURRENT_DOCUMENT_REQUEST, schemaVersion: BUSINESS_SCHEMA_VERSION + 2, explicitRetry: true },
  ])
  expect(vi.getTimerCount()).toBe(0)
})

it("uses the newer worker's actual protocol rather than waiting for an obsolete exact target", async () => {
  const h = workerFixture(BUSINESS_SCHEMA_VERSION + 2)
  requestBusinessSchemaUpdate(BUSINESS_SCHEMA_VERSION + 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(businessSchemaLifecycle.get().expectedVersion).toBe(BUSINESS_SCHEMA_VERSION + 2)
  expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([
    { type: CURRENT_DOCUMENT_REQUEST, schemaVersion: BUSINESS_SCHEMA_VERSION + 2, explicitRetry: false },
  ])
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["available", "registration-fails"] as const)("creates a missing registration and preserves explicit recovery: %s", async mode => {
  const h = workerFixture()
  h.serviceWorker.getRegistration.mockResolvedValue(undefined)
  if (mode === "registration-fails") h.serviceWorker.register.mockRejectedValueOnce(new Error("Registration unavailable"))
  requestBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.serviceWorker.register).toHaveBeenCalledExactlyOnceWith("/sw.js", { scope: "/", updateViaCache: "none" })
  if (mode === "registration-fails") {
    expect(businessSchemaLifecycle.get().phase).toBe("failed")
    expect(h.messages).toEqual([])
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.serviceWorker.register).toHaveBeenCalledTimes(2)
  }
  expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it("allows explicit no-worker Retry with an existing URL marker while retaining automatic loop protection", async () => {
  vi.useFakeTimers()
  const replace = vi.fn()
  vi.stubGlobal("navigator", {})
  vi.stubGlobal("window", { location: { href: "https://alook.test/c/me?keep=1&__alook_schema_update=" + BUSINESS_SCHEMA_VERSION + "#marked", replace } })
  vi.stubGlobal("sessionStorage", { getItem: () => String(BUSINESS_SCHEMA_VERSION), setItem: vi.fn() })
  requestBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(businessSchemaLifecycle.get().phase).toBe("failed")
  expect(replace).not.toHaveBeenCalled()
  retryBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  expect(replace).toHaveBeenCalledExactlyOnceWith("https://alook.test/c/me?keep=1&__alook_schema_update=" + BUSINESS_SCHEMA_VERSION + "#marked")
  expect(vi.getTimerCount()).toBe(0)
})

it("requalifies a controller replaced while a late owner's retirement is still pending", async () => {
  const h = workerFixture()
  let releaseUpdate!: () => void, releaseOwner!: () => void
  const update = new Promise<void>(resolve => { releaseUpdate = resolve })
  const held = new Promise<void>(resolve => { releaseOwner = resolve })
  h.registration.update.mockImplementation(() => update)
  requestBusinessSchemaUpdate()
  await vi.advanceTimersByTimeAsync(0)
  const unregister = registerBusinessSchemaOwner(() => held)
  try {
    releaseUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages.map(message => message.type)).toEqual([WORKER_VERSION_PROBE])
    const nextMessages: Array<{ type: string; schemaVersion?: number }> = []
    h.serviceWorker.controller = { postMessage: (message, ports) => {
      nextMessages.push(message)
      ports[0].postMessage(message.type === WORKER_VERSION_PROBE
        ? { schemaVersion: BUSINESS_SCHEMA_VERSION + 1 } : { navigating: true })
    } }
    h.serviceWorker.dispatchEvent(new Event("controllerchange"))
    releaseOwner()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([])
    expect(nextMessages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([
      { type: CURRENT_DOCUMENT_REQUEST, schemaVersion: BUSINESS_SCHEMA_VERSION + 1, explicitRetry: false },
    ])
    expect(vi.getTimerCount()).toBe(0)
  } finally { releaseUpdate(); releaseOwner(); unregister() }
})
