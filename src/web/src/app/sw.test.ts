import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe("public worker activation", () => {
  it("runs actual Serwist activation and deletes old custom cache names without changing the current cache", async () => {
    const names = new Set(["alook-public-precache-v0", "alook-public-precache-v1", "alook-public-v99-runtime", "unrelated-cache"])
    const storage = { keys: vi.fn(async () => [...names]), delete: vi.fn(async (name: string) => names.delete(name)),
      open: vi.fn(async (name: string) => { names.add(name); return { keys: async () => [] as Request[] } }) }
    const listeners = new Map<string, Array<(event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown>>()
    const location = new URL("https://example.test/sw.js")
    const worker = { __SW_MANIFEST: [], location, caches: storage, registration: { scope: "https://example.test/" }, clients: { claim: vi.fn(async () => undefined) },
      addEventListener: (type: string, listener: (event: { waitUntil: (promise: Promise<unknown>) => void }) => unknown) => listeners.set(type, [...listeners.get(type) ?? [], listener]) }
    vi.stubGlobal("self", worker)
    vi.stubGlobal("location", location)
    vi.stubGlobal("caches", storage)
    await import("./sw")
    const pending: Promise<unknown>[] = []
    for (const listener of listeners.get("activate") ?? []) listener({ waitUntil: promise => { pending.push(promise) } })
    await Promise.all(pending)
    expect(worker.clients.claim).toHaveBeenCalledOnce()
    expect(names).toEqual(new Set(["alook-public-precache-v1", "unrelated-cache"]))
    expect(storage.delete.mock.calls.map(([name]) => name)).toEqual(["alook-public-precache-v0", "alook-public-v99-runtime"])
    expect(storage.open).toHaveBeenCalledWith("alook-public-precache-v1")
    expect(listeners.has("fetch")).toBe(true)
  })
})
