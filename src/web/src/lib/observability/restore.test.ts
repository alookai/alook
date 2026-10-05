import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hashKey, hydrate, QueryClient } from "@tanstack/react-query"
import type { PersistedClient } from "@tanstack/react-query-persist-client"
import { observeRestoreRead, observeRestoreDecode, observeHydration } from "./restore"
import { valueEvidence } from "./data-source"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"

const snapshot = (): PersistedClient => ({ timestamp: Date.now(), buster: "current", clientState: { mutations: [], queries: [{ queryKey: ["community", "db", "account-a", "messages"], queryHash: hashKey(["community", "db", "account-a", "messages"]), state: { data: [{ id: "one", content: "private" }], dataUpdatedAt: Date.now(), dataUpdateCount: 1, error: null, errorUpdatedAt: 0, errorUpdateCount: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: "success", fetchStatus: "idle" } }] } })
describe("restore observation admission", () => {
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  let client: QueryClient
  const activate = (id: string) => { configureTelemetry({ session_id: id }, true); installTelemetrySink(event => events.push(event)) }
  beforeEach(() => { client = new QueryClient(); events.length = 0; activate("session-a") })
  afterEach(() => { retireTelemetry(); client.clear() })
  it("tags only the unchanged snapshot actually hydrated in the admitted generation", async () => {
    const persister = {}, data = snapshot()
    await observeRestoreRead(async () => JSON.stringify(data), persister)
    const decoded = observeRestoreDecode(persister, () => data, "current", 10000)
    hydrate(client, decoded.clientState); observeHydration(persister, client)
    expect(events.filter(event => event.name === "cache.restore.finish").map(event => event.attributes.outcome)).toEqual(["hit", "hit", "success"])
    expect(valueEvidence(client, client.getQueryData(["community", "db", "account-a", "messages"])).source).toBe("restored_idb")
    expect(JSON.stringify(events)).not.toContain("private")
  })
  it("does not emit a late read, decode or hydrate into a regranted account session", async () => {
    const persister = {}, data = snapshot()
    let resolve!: (value: string) => void
    const reading = observeRestoreRead(() => new Promise<string>(done => { resolve = done }), persister)
    retireTelemetry(); activate("session-b"); events.length = 0
    resolve(JSON.stringify(data)); await reading
    const decoded = observeRestoreDecode(persister, () => data, "current", 10000)
    hydrate(client, decoded.clientState); observeHydration(persister, client)
    expect(events).toEqual([])
    expect(valueEvidence(client, client.getQueryData(["community", "db", "account-a", "messages"])).source).toBe("unknown")
  })
  it("rejects an old hydration-helper callback and preserves a fresh replacement query", async () => {
    const persister = {}, data = snapshot()
    await observeRestoreRead(async () => JSON.stringify(data), persister)
    observeRestoreDecode(persister, () => data, "current", 10000)
    retireTelemetry(); activate("session-b"); events.length = 0
    client.setQueryData(["community", "db", "account-a", "messages"], [{ id: "new" }])
    observeHydration(persister, client)
    expect(events).toEqual([])
    expect(client.getQueryData(["community", "db", "account-a", "messages"])).toEqual([{ id: "new" }])
  })
  it("preserves original read/decode failures and records only eligible error phases", async () => {
    const failure = new Error("private-storage-error"), persister = {}
    await expect(observeRestoreRead(async () => { throw failure }, persister)).rejects.toBe(failure)
    expect(() => observeRestoreDecode(persister, () => { throw failure }, "current", 10000)).toThrow(failure)
    expect(events.filter(event => event.name === "cache.restore.finish").map(event => [event.attributes.phase, event.attributes.outcome])).toEqual([["idb_read", "error"], ["deserialize", "error"]])
    expect(JSON.stringify(events)).not.toContain(failure.message)
    retireTelemetry(); events.length = 0
    await expect(observeRestoreRead(async () => { throw failure })).rejects.toBe(failure)
    expect(() => observeRestoreDecode({}, () => { throw failure }, "current", 10000)).toThrow(failure)
    expect(events).toEqual([])
  })

})
