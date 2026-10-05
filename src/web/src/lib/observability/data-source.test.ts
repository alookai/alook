import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { collectionEvidence, recordRows, disposeSources, tagView, viewEvidence, mergeEvidence, withSource, sourceEvidence } from "./data-source"
import { configureTelemetry, retireTelemetry } from "./telemetry"

describe("actual row and window provenance", () => {
  let client: QueryClient
  beforeEach(() => { client = new QueryClient(); configureTelemetry({}, true) })
  afterEach(() => { retireTelemetry(); disposeSources(client); client.clear() })
  it("preserves unchanged IDB versions through validation, replaces changed fields conservatively", () => {
    const cached = [{ id: "one", content: "private", reaction: 0 }, { id: "two", content: "private", reaction: 0 }]
    recordRows(client, "messages", cached, row => row.id, "restored_idb")
    const initial = collectionEvidence(client, "messages", ["one"])
    expect(initial.source).toBe("restored_idb")
    recordRows(client, "messages", cached.map(row => ({ ...row })), row => row.id, "network")
    const validated = collectionEvidence(client, "messages", ["one"])
    expect(validated.version).toBe(initial.version)
    expect(validated.source).toBe("restored_idb")
    expect(validated.freshness).toBe("validated")
    recordRows(client, "messages", [{ ...cached[0]!, reaction: 1 }, cached[1]!], row => row.id, "ws")
    expect(collectionEvidence(client, "messages", ["one"]).source).toBe("mixed")
    expect(collectionEvidence(client, "messages", ["two"]).source).toBe("restored_idb")
    expect(collectionEvidence(client, "messages", ["one"]).version).not.toBe(initial.version)
  })
  it("marks an untracked optimistic row unknown, never reuses IDB labels on it", () => {
    const row = { id: "one", content: "original" }
    recordRows(client, "messages", [row], item => item.id, "restored_idb")
    expect(collectionEvidence(client, "messages", ["one"], [{ ...row, content: "edited" }]).source).toBe("unknown")
  })
  it("gives local preference snapshots stable versions while retaining unknown provenance", () => {
    const one = {}, two = {}
    const first = sourceEvidence(one, "unknown")
    expect(first.version).not.toBe("unknown")
    expect(sourceEvidence(one, "unknown")).toEqual(first)
    expect(sourceEvidence(two, "unknown")).toMatchObject({ source: "unknown" })
    expect(sourceEvidence(two, "unknown").version).not.toBe(first.version)
  })
  it("binds snapshots to rendered values; later writes cannot mutate an old snapshot", () => {
    recordRows(client, "messages", [{ id: "one", content: "old" }], item => item.id, "restored_idb")
    const view = tagView({}, collectionEvidence(client, "messages", ["one"]))
    recordRows(client, "messages", [{ id: "one", content: "new" }], item => item.id, "network")
    expect(viewEvidence(view).source).toBe("restored_idb")
    expect(viewEvidence(view).version).not.toBe(collectionEvidence(client, "messages", ["one"]).version)
  })
  it("carries the original WS apply receipt into the actual rendered row and expires it on retirement", () => {
    const row = { id: "one", content: "changed" }
    withSource(client, "ws", () => recordRows(client, "messages", [row], item => item.id), { id: "event-a", start: 10 })
    const rendered = tagView({}, collectionEvidence(client, "messages", ["one"], [row]))
    expect(viewEvidence(rendered)).toMatchObject({ wsEventId: "event-a", wsStart: 10, source: "ws" })
    retireTelemetry(); configureTelemetry({}, true)
    expect(viewEvidence(rendered).wsEventId).toBeUndefined()
  })
  it("handles authoritative empty, deletion, owner retirement and mixed joins", () => {
    recordRows(client, "messages", [], (row: {id:string}) => row.id, "network")
    expect(collectionEvidence(client, "messages", []).source).toBe("network")
    recordRows(client, "profiles", [{ id: "one" }], row => row.id, "restored_idb")
    const joined = mergeEvidence([collectionEvidence(client,"profiles",["one"]), collectionEvidence(client,"messages",[])])
    expect(joined.source).toBe("mixed")
    recordRows(client, "profiles", [], (row: {id:string})=>row.id,"ws")
    expect(collectionEvidence(client,"profiles",["one"]).source).toBe("unknown")
    disposeSources(client)
    expect(collectionEvidence(client,"profiles",[]).source).toBe("unknown")
  })
})
