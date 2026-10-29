import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { fingerprintRuntimeModelCatalog } from "@alook/shared"
import { waitForModelDiscovery, completeModelDiscoveryWait } from "./model-discovery-wait"
const command = { requestId: "request", runtimeId: "codex" }
const result = { status: "complete" as const, catalog: { updateMode: "unsupported" as const, models: [{ id: "fresh-model", supportedReasoningEfforts: [] }] } }
function fixture() {
  const store = new Map<string, any>()
  let queue = Promise.resolve()
  const methods = (target: Map<string, any>) => ({
    get: async (key: string) => target.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => { if (typeof key === "string") target.set(key, value); else for (const [name, entry] of Object.entries(key)) target.set(name, entry) },
    delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) target.delete(key) },
    list: async ({ prefix }: { prefix: string }) => new Map([...target].filter(([key]) => key.startsWith(prefix))),
  })
  const storage = { ...methods(store), transaction: async (run: (txn: ReturnType<typeof methods>) => Promise<any>) => {
    const operation = queue.then(async () => { const copy = new Map(store); const result = await run(methods(copy)); store.clear(); for (const [key, value] of copy) store.set(key, value); return result })
    queue = operation.catch(() => {})
    return operation
  } }
  const context = { ctx: { storage } } as never
  const dispatch = vi.fn(() => ({ sent: 1, unsupported: 0 }))
  return { store, context, dispatch }
}
let catalogFingerprint: string
beforeEach(async () => { vi.useFakeTimers(); catalogFingerprint = await fingerprintRuntimeModelCatalog(result.catalog) })
afterEach(() => vi.useRealTimers())
it("registers before dispatch and returns only its matching terminal catalog", async () => {
  const f = fixture()
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.dispatch).toHaveBeenCalledOnce()
  expect(f.store.has("model-discovery-wait:request")).toBe(true)
  await completeModelDiscoveryWait(f.context, "other-request", "codex", result)
  await completeModelDiscoveryWait(f.context, "request", "other-runtime", result)
  expect(f.store.get("model-discovery-wait:request").completed).toBeUndefined()
  await completeModelDiscoveryWait(f.context, "request", "codex", result)
  await completeModelDiscoveryWait(f.context, "request", "codex", { status: "error", code: "late", message: "late" })
  await vi.advanceTimersByTimeAsync(250)
  expect(await waiting).toEqual({ sent: 1, unsupported: 0, cached: false, observedAt: expect.any(String), result })
  expect([...f.store.keys()].filter((key) => /model-discovery-(wait|result):/.test(key))).toEqual([])
})
it("returns errors and removes all durable state without substituting a catalog", async () => {
  const f = fixture()
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  const error = { status: "error" as const, code: "auth_required", message: "Sign in" }
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, error)
  await vi.advanceTimersByTimeAsync(250)
  expect(await waiting).toMatchObject({ result: error })
  expect(f.store.size).toBe(0)
})
it("bounds waits and drops late results", async () => {
  const f = fixture()
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(45_000)
  expect(await waiting).toMatchObject({ result: { status: "error", code: "MODEL_DISCOVERY_TIMEOUT" } })
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  expect(f.store.size).toBe(0)
})
it("cleans zero-delivery and throwing dispatches", async () => {
  const f = fixture()
  expect(await waitForModelDiscovery(f.context, command, () => ({ sent: 0, unsupported: 1 }))).toEqual({ sent: 0, unsupported: 1 })
  await expect(waitForModelDiscovery(f.context, command, () => { throw new Error("offline") })).rejects.toThrow("offline")
  expect(f.store.size).toBe(0)
})
it("rejects duplicate/capacity requests before dispatch and reclaims expired records", async () => {
  const f = fixture()
  for (let index = 0; index < 16; index++) f.store.set(`model-discovery-wait:${index}`, { runtimeId: "codex", expiresAt: Date.now() + 1000 })
  await expect(waitForModelDiscovery(f.context, command, f.dispatch)).rejects.toThrow("busy")
  expect(f.dispatch).not.toHaveBeenCalled()
  f.store.clear()
  f.store.set("model-discovery-wait:request", { runtimeId: "codex", expiresAt: Date.now() + 1000 })
  await expect(waitForModelDiscovery(f.context, command, f.dispatch)).rejects.toThrow("busy")
  f.store.set("model-discovery-wait:request", { runtimeId: "codex", expiresAt: Date.now() - 1, completed: true })
  f.store.set("model-discovery-result:request", "expired")
  await waitForModelDiscovery(f.context, command, () => ({ sent: 0, unsupported: 0 }))
  expect(f.store.size).toBe(0)
})
it("preserves a large Unicode catalog in one bounded temporary result record", async () => {
  const f = fixture()
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  const large = { status: "complete" as const, catalog: { updateMode: "unsupported" as const, models: Array.from({ length: 1024 }, (_, index) => ({ id: `model-${index}`, displayName: "模型".repeat(100), supportedReasoningEfforts: [] })) } }
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, large)
  expect(f.store.get("model-discovery-wait:request").completed).toBe(true)
  const records = [...f.store].filter(([key]) => key.startsWith("model-discovery-result:"))
  expect(records).toHaveLength(1)
  expect(Buffer.byteLength(records[0][1])).toBeGreaterThan(128 * 1024)
  expect(Buffer.byteLength(records[0][0]) + records[0][1].byteLength).toBeLessThanOrEqual(2_000_000)
  await vi.advanceTimersByTimeAsync(250)
  expect(await waiting).toMatchObject({ result: large })
  expect([...f.store.keys()].filter((key) => /model-discovery-(wait|result):/.test(key))).toEqual([])
})

it("reuses five-minute successful cache without dispatch, forces refresh and expires at the boundary", async () => {
  const f = fixture()
  const first = waitForModelDiscovery(f.context, command, f.dispatch, { useCache: true, catalogFingerprint })
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  const fresh = await first
  const cached = await waitForModelDiscovery(f.context, command, f.dispatch, { useCache: true, catalogFingerprint })
  expect(cached).toEqual({ sent: 0, unsupported: 0, cached: true, observedAt: fresh.observedAt, catalogFingerprint })
  expect(f.dispatch).toHaveBeenCalledOnce()
  const forced = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.dispatch).toHaveBeenCalledTimes(2)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  await forced
  await vi.advanceTimersByTimeAsync(299_750)
  const expired = waitForModelDiscovery(f.context, command, f.dispatch, { useCache: true, catalogFingerprint })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.dispatch).toHaveBeenCalledTimes(3)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  expect(await expired).toMatchObject({ cached: false })
})
it("does not cache errors or extend cache age from duplicate, late or unrelated reports", async () => {
  const f = fixture()
  const first = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  await first
  const original = structuredClone(f.store.get("model-discovery-cache:codex"))
  await vi.advanceTimersByTimeAsync(1000)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await completeModelDiscoveryWait(f.context, "unrelated", command.runtimeId, result)
  const failure = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, { status: "error", code: "failed", message: "Failed" })
  await vi.advanceTimersByTimeAsync(250)
  await failure
  expect(f.store.get("model-discovery-cache:codex")).toEqual(original)
})

it("bounds retained backend metadata and deletes expired entries", async () => {
  const f = fixture()
  for (let index = 0; index < 64; index++) {
    f.store.set(`model-discovery-cache:backend${index}`, { catalogFingerprint, observedAt: Date.now() - 1000 + index })
  }
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  await waiting
  expect([...f.store.keys()].filter((key) => key.startsWith("model-discovery-cache:"))).toHaveLength(64)
  expect(f.store.has("model-discovery-cache:backend0")).toBe(false)
  await vi.advanceTimersByTimeAsync(300_000)
  const renewal = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  await renewal
  expect([...f.store.keys()].filter((key) => key.startsWith("model-discovery-cache:"))).toEqual(["model-discovery-cache:codex"])
  expect(f.store.has("model-discovery-cache:backend1")).toBe(false)
})
it("does not share a cache across credential contexts or trust a future discovery timestamp", async () => {
  const f = fixture()
  f.store.set("model-discovery-cache:codex", { catalogFingerprint, observedAt: Date.now() + 1 })
  await waitForModelDiscovery(f.context, command, () => ({ sent: 0, unsupported: 1 }), { useCache: true, catalogFingerprint })
  const other = fixture()
  await waitForModelDiscovery(other.context, command, () => ({ sent: 0, unsupported: 1 }), { useCache: true, catalogFingerprint })
  expect(other.store.size).toBe(0)
})

it("retains only discovery metadata and invalidates a cache when the D1 catalog fingerprint changes", async () => {
  const f = fixture()
  const first = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  await first
  expect(f.store.get("model-discovery-cache:codex")).toEqual({ observedAt: expect.any(Number), catalogFingerprint })
  expect([...f.store.keys()]).toEqual(["model-discovery-cache:codex"])
  const changed = waitForModelDiscovery(f.context, command, f.dispatch, { useCache: true, catalogFingerprint: "b".repeat(64) })
  await vi.advanceTimersByTimeAsync(0)
  expect(f.dispatch).toHaveBeenCalledTimes(2)
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, result)
  await vi.advanceTimersByTimeAsync(250)
  expect(await changed).toMatchObject({ cached: false, result })
})
it("returns an explicit bounded error for an oversized result and does not cache it", async () => {
  const f = fixture()
  const waiting = waitForModelDiscovery(f.context, command, f.dispatch)
  await vi.advanceTimersByTimeAsync(0)
  const huge = { status: "complete" as const, catalog: { updateMode: "unsupported" as const, models: [{ id: "huge", displayName: "x".repeat(2_000_000), supportedReasoningEfforts: [] }] } }
  await completeModelDiscoveryWait(f.context, command.requestId, command.runtimeId, huge)
  const record = f.store.get("model-discovery-result:request")
  expect(Buffer.byteLength(record)).toBeLessThan(1000)
  expect(f.store.has("model-discovery-cache:codex")).toBe(false)
  await vi.advanceTimersByTimeAsync(250)
  expect(await waiting).toMatchObject({ result: { status: "error", code: "MODEL_DISCOVERY_RESULT_TOO_LARGE" } })
  expect(f.store.size).toBe(0)
})
