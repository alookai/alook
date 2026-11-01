import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { apiFetch } from "./api/client"
import { businessSchemaLifecycle, retryBusinessSchemaUpdate } from "./business-schema-lifecycle"
import { CURRENT_DOCUMENT_REQUEST, WORKER_VERSION_PROBE } from "./service-worker/business-upgrade"

beforeEach(() => {
  vi.useFakeTimers()
  businessSchemaLifecycle.setState(() => ({ phase: "current", expectedVersion: BUSINESS_SCHEMA_VERSION }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

function install(version: number, initiallyAvailable: boolean) {
  class Channel {
    port1 = { onmessage: null as ((event: { data: unknown }) => void) | null, close: vi.fn() }
    port2 = { postMessage: (data: unknown) => this.port1.onmessage?.({ data }), close: vi.fn() }
  }
  const messages: Array<{ type: string; schemaVersion?: number }> = []
  const worker = { postMessage: vi.fn((message: { type: string; schemaVersion?: number }, ports?: Array<{ postMessage(data: unknown): void }>) => {
    messages.push(message)
    if (message.type === WORKER_VERSION_PROBE) ports![0].postMessage({ schemaVersion: BUSINESS_SCHEMA_VERSION })
    if (message.type === CURRENT_DOCUMENT_REQUEST) ports![0].postMessage({ navigating: true })
  }) }
  const registration = Object.assign(new EventTarget(), { update: vi.fn(async () => undefined), active: worker, waiting: null, installing: null })
  let available = initiallyAvailable, header = version
  const getRegistration = vi.fn(async () => available ? registration : undefined)
  const serviceWorker = Object.assign(new EventTarget(), { getRegistration, controller: worker })
  const storage = new Map<string, string>()
  const replace = vi.fn()
  vi.stubGlobal("MessageChannel", Channel)
  vi.stubGlobal("window", { location: { href: "https://alook.test/c/me", replace } })
  vi.stubGlobal("navigator", { serviceWorker })
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  const fetch = vi.fn(async () => Response.json({ contractVersion: header }, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(header) } }))
  vi.stubGlobal("fetch", fetch)
  return { messages, getRegistration, replace, fetch, recover: () => { available = true; header = BUSINESS_SCHEMA_VERSION } }
}

describe("actual confirmation rejection and document lifecycle", () => {
  it("recovers an old confirmation through explicit Retry to the available current worker", async () => {
    const h = install(BUSINESS_SCHEMA_VERSION - 1, false)
    const error = await apiFetch("/api/community/channels/channel").catch(error => error)
    expect(error.name).toBe("BusinessSchemaMismatch")
    await vi.advanceTimersByTimeAsync(0)
    const selected = businessSchemaLifecycle.get().expectedVersion
    expect(businessSchemaLifecycle.get().phase).toBe("failed")
    h.recover()
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(10_000)
    expect({ selected, finalExpected: businessSchemaLifecycle.get().expectedVersion,
      phase: businessSchemaLifecycle.get().phase,
      documents: h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST).map(message => message.schemaVersion) })
      .toEqual({ selected: BUSINESS_SCHEMA_VERSION, finalExpected: BUSINESS_SCHEMA_VERSION, phase: "updating", documents: [BUSINESS_SCHEMA_VERSION] })
    expect(h.getRegistration).toHaveBeenCalledTimes(2)
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.replace).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("fails finitely for an unavailable actual future confirmation without choosing the current document", async () => {
    const expected = BUSINESS_SCHEMA_VERSION + 1
    const h = install(expected, true)
    await expect(apiFetch("/api/community/channels/channel")).rejects.toMatchObject({ name: "BusinessSchemaMismatch", expectedVersion: expected })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(businessSchemaLifecycle.get()).toEqual({ phase: "failed", expectedVersion: expected })
    retryBusinessSchemaUpdate()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(businessSchemaLifecycle.get()).toEqual({ phase: "failed", expectedVersion: expected })
    expect(h.messages.filter(message => message.type === CURRENT_DOCUMENT_REQUEST)).toEqual([])
    expect(h.getRegistration).toHaveBeenCalledTimes(2)
    expect(h.replace).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
