import { afterEach, beforeEach, expect, it } from "vitest"
import { createMessageStreamStore } from "@/stores/community/message-stream-store"
import { QueryClient } from "@tanstack/react-query"
import { observeQueryClient, disposeQueryDiagnostics } from "./query-observer"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"
import { commandObservation, clearActions } from "./context"

let client: QueryClient
const events: Array<{ name: string; attributes: Record<string, string> }> = []
beforeEach(() => { client = observeQueryClient(new QueryClient()); events.length = 0; configureTelemetry({ session_id: "session-a" }, true); installTelemetrySink(event => events.push(event)) })
afterEach(() => { retireTelemetry(); clearActions(); disposeQueryDiagnostics(client); client.clear() })
it("observes unlabelled Query and Mutation lifecycles without reading keys, values or variables", async () => {
  const value = { content: "private-body" }
  expect(await client.query({ queryKey: ["private-key"], queryFn: () => value })).toBe(value)
  const mutation = client.getMutationCache().build(client, { mutationFn: async (input: typeof value) => input })
  expect(await mutation.execute(value)).toBe(value)
  expect(events.filter(event => event.name === "query.lifecycle").map(event => event.attributes.outcome)).toEqual(["observed", "success"])
  expect(events.filter(event => event.name === "action.start").map(event => event.attributes.action_name)).toEqual(["command.unknown"])
  expect(events.filter(event => event.name === "action.finish")).toHaveLength(1)
  expect(JSON.stringify(events)).not.toContain("private")
})
it("does not send late Query terminals into a replacement session", async () => {
  let resolve!: (value: object) => void
  const pending = client.query({ queryKey: ["private"], queryFn: () => new Promise<object>(done => { resolve = done }) })
  await Promise.resolve()
  retireTelemetry(); configureTelemetry({ session_id: "session-b" }, true); installTelemetrySink(event => events.push(event))
  events.length = 0
  resolve({ private: true }); await pending
  expect(events).toEqual([])
})
it("uses native mutation pending/terminal events once and binds each original request token", async () => {
  const one = { original: {} }, two = { original: {} }
  let resolve!: () => void
  const waiting = new Promise<void>(done => { resolve = done })
  const build = (name: string) => client.getMutationCache().build(client, { meta: { observabilityAction: name }, mutationFn: async (input: typeof one) => {
    expect(commandObservation(input.original)?.action?.name).toBe(name)
    await waiting
  } })
  const a = build("message.edit").execute(one), b = build("message.pin").execute(two)
  await Promise.resolve()
  expect(events.filter(event => event.name === "action.start")).toHaveLength(2)
  resolve(); await Promise.all([a, b])
  expect(events.filter(event => event.name === "action.finish")).toHaveLength(2)
  expect(new Set(events.filter(event => event.name === "action.start").map(event => event.attributes.action_id)).size).toBe(2)
  const delegated = client.getMutationCache().build(client, { meta: { observabilityAction: "member.management.command", observabilityDelegate: true }, mutationFn: async () => undefined })
  await delegated.execute(undefined)
  expect(events.filter(event => event.name === "action.start")).toHaveLength(2)
})

it("joins optimistic acceptance and the native send acknowledgment without a duplicate lifecycle", async () => {
  const stream = createMessageStreamStore(undefined, client)
  const scope = { kind: "channel" as const, id: "channel", serverId: "server" }
  const input = { original: {}, nonce: "private-nonce" }
  stream.actions.accept(scope, { nonce: input.nonce, tempId: "temp", message: { type: "chat", content: "private-body" }, localUploads: [] })
  const command = client.getMutationCache().build(client, { meta: { observabilityAction: "channel.message.send" }, mutationFn: async (args: typeof input) => {
    expect(commandObservation(args.original)?.action?.id).toBe(events.find(event => event.name === "action.start")?.attributes.action_id)
    stream.actions.dispatch(scope, { type: "postAck", nonce: args.nonce, message: { id: "message", seq: 1, type: "chat", content: "private-body" } })
  } })
  await command.execute(input)
  expect(events.filter(event => event.name === "action.start")).toHaveLength(1)
  expect(events.filter(event => event.name === "action.finish")).toHaveLength(1)
  expect(events.filter(event => event.name === "message.milestone").map(event => event.attributes.phase)).toEqual(["optimistic", "ack"])
  expect(JSON.stringify(events)).not.toContain("private")
  retireTelemetry(); configureTelemetry({ session_id: "session-b" }, true); installTelemetrySink(event => events.push(event))
  const count = events.length
  stream.actions.dispatch(scope, { type: "postFail", nonce: input.nonce })
  expect(events).toHaveLength(count)
})
it("keeps owner friend decisions as distinct stable native mutation semantics", async () => {
  for (const decision of ["approve", "deny"]) {
    await client.getMutationCache().build(client, { meta: { observabilityAction: "friend.owner_decision.command" }, mutationFn: async () => undefined }).execute({ decision, original: {} })
  }
  expect(events.filter(event => event.name === "action.start").map(event => event.attributes.action_name)).toEqual(["friend.request.approve", "friend.request.deny"])
})
