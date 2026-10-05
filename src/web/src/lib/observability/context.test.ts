import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bindCommandAction, beginNavigation, clearActions, commandObservation, finishAction, startAction, installActionSpans, navigationForHref } from "./context"
import { alignInitialTelemetrySession, configureTelemetry, emitTelemetry, installTelemetrySink, retireTelemetry, telemetryGeneration } from "./telemetry"
import type { Span } from "@opentelemetry/api"
import { startRequest, requestHeaders, readObservedResponse } from "./requests"
import { resolveActionName } from "./actions"

describe("original observation ownership", () => {
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  beforeEach(() => { vi.useFakeTimers(); events.length = 0; configureTelemetry({ session_id: "session-a" }, true); installTelemetrySink(event => events.push(event)) })
  afterEach(() => { retireTelemetry(); clearActions(); installActionSpans(undefined); vi.useRealTimers() })
  it("keeps an intent through synchronous native session extension and ends the returned span", () => {
    const end = vi.fn()
    installActionSpans(() => {
      retireTelemetry("native_session"); clearActions()
      configureTelemetry({ session_id: "session-b" }, true); installTelemetrySink(event => events.push(event))
      return { end, setAttribute: vi.fn() } as unknown as Span
    })
    const action = beginNavigation("/c/me/bots")!
    expect(action.done).toBe(false)
    expect(action.generation).toBe(telemetryGeneration())
    expect(navigationForHref("/c/me/bots")).toBe(action)
    finishAction(action, "success")
    expect(end).toHaveBeenCalledTimes(1)
    expect(events.filter(event => ["action.start", "action.finish"].includes(event.name)).map(event => event.attributes.session_id)).toEqual(["session-b", "session-b"])
  })
  it("ends and discards a span when its factory crosses a revoke or account boundary", () => {
    const end = vi.fn()
    installActionSpans(() => {
      retireTelemetry(); clearActions(); configureTelemetry({ session_id: "account-b" }, true); installTelemetrySink(event => events.push(event))
      return { end } as unknown as Span
    })
    expect(startAction("message.edit")).toBeUndefined()
    expect(end).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event.name.startsWith("action."))).toEqual([])
  })
  it("passes only present whitelisted attributes to native action spans", () => {
    const factory = vi.fn((_name: string, _fields: Record<string, string>) => ({ end: vi.fn(), setAttribute: vi.fn() } as unknown as Span))
    installActionSpans(factory)
    const dm = startAction("dm.message.send")!
    const navigation = beginNavigation("/c/me/bots")!
    const dmFields = factory.mock.calls[0]![1] as Record<string, string>
    const navigationFields = factory.mock.calls[1]![1] as Record<string, string>
    expect(dmFields).toMatchObject({ action_id: dm.id, action_name: "dm.message.send", start_ms: String(dm.start) })
    expect(dmFields).not.toHaveProperty("navigation_id")
    expect(dmFields).not.toHaveProperty("trace_id")
    expect(dmFields).not.toHaveProperty("span_id")
    expect(Object.values(dmFields)).not.toContain("undefined")
    expect(navigationFields.navigation_id).toBe(navigation.navigationId)
    finishAction(dm, undefined)
    expect(dm.span!.setAttribute).not.toHaveBeenCalled()
    finishAction(navigation, "success")
    expect(navigation.span!.setAttribute).toHaveBeenCalledWith("outcome", "success")
  })
  it("keeps concurrent commands and their requests on their original tokens", async () => {
    const one = { original: {} }, two = { original: {} }
    const a = startAction("message.edit")!, b = startAction("message.pin")!
    bindCommandAction(one, a); bindCommandAction(two, b)
    const request = startRequest("/api/community/messages/private", { method: "PATCH", observation: commandObservation(one.original) })
    const response = new Response("{}", { headers: { "cf-ray": "a".repeat(16) + "-SJC" } })
    requestHeaders(request, response)
    await readObservedResponse(response, () => response.json())
    finishAction(b, "success"); finishAction(a, "success")
    expect(events.filter(event => event.name.startsWith("request.")).every(event => event.attributes.action_id === a.id)).toBe(true)
    expect(commandObservation(two.original)?.action?.id).toBe(b.id)
    expect(events.filter(event => event.name === "action.finish").map(event => event.attributes.action_id)).toEqual([b.id, a.id])
    expect(JSON.stringify(events)).not.toContain("private")
  })
  it("rejects old parsed responses, actions and command contexts after retirement", async () => {
    const intent = { original: {} }, action = startAction("message.edit")!
    bindCommandAction(intent, action)
    const request = startRequest("/api/community/messages/private", { observation: commandObservation(intent.original) })
    const response = new Response("{}")
    requestHeaders(request, response)
    retireTelemetry(); configureTelemetry({ session_id: "session-b" }, true); installTelemetrySink(event => events.push(event)); events.length = 0
    await readObservedResponse(response, () => response.json())
    finishAction(action, "success")
    expect(events).toEqual([])
    expect(commandObservation(intent.original)).toBeUndefined()
  })
  it("closes superseded navigation once and records the winner independently", () => {
    const a = beginNavigation("/c/me/bots")!, b = beginNavigation("/c/me/friends")!, c = beginNavigation("/c/me/machines")!
    finishAction(c, "success"); finishAction(a, "success"); finishAction(b, "success")
    expect(events.filter(event => event.name === "action.finish").map(event => event.attributes.outcome)).toEqual(["superseded", "superseded", "success"])
  })
  it("bounds pre-SDK events and separates event drops from delivery failures", () => {
    retireTelemetry(); configureTelemetry({ session_id: "session-c" }, true); events.length = 0
    for (let i = 0; i < 300; i++) emitTelemetry("telemetry.coverage", { count: i })
    installTelemetrySink(event => events.push(event))
    expect(events).toHaveLength(257)
    expect(events.at(-1)?.attributes).toMatchObject({ drop_count: "44", drop_reason: "early_queue_full" })
  })
  it("preserves an accepted unsent intent, request ownership and timestamp across initial native identity alignment", async () => {
    retireTelemetry(); clearActions(); configureTelemetry({ session_id: "provisional" }, true)
    const generation = telemetryGeneration(), timestamp = Date.now()
    const action = startAction("message.edit")!
    const request = startRequest("/api/community/messages/private", { observation: { action, reason: "command" } })
    const response = new Response("{}")
    vi.setSystemTime(timestamp + 500)
    expect(alignInitialTelemetrySession("provisional", "native-session")).toBe(true)
    expect(telemetryGeneration()).toBe(generation)
    expect(action.done).toBe(false)
    requestHeaders(request, response)
    await readObservedResponse(response, () => response.json())
    finishAction(action, "success")
    const pending: Array<{ name: string; timestamp: number; attributes: Record<string, string> }> = []
    installTelemetrySink(event => pending.push(event))
    expect(pending[0]).toMatchObject({ name: "action.start", timestamp, attributes: { session_id: "native-session", action_id: action.id } })
    expect(pending.every(event => event.attributes.session_id === "native-session" && event.attributes.action_id === action.id)).toBe(true)
    expect(pending.some(event => event.name === "request.body_parsed")).toBe(true)
    expect(pending.at(-1)?.name).toBe("action.finish")
  })
  it("does not align a live sink, a different pending identity, or retired work", () => {
    expect(alignInitialTelemetrySession("session-a", "native-session")).toBe(false)
    retireTelemetry(); configureTelemetry({ session_id: "provisional" }, true)
    emitTelemetry("business.result", { session_id: "different" })
    expect(alignInitialTelemetrySession("provisional", "native-session")).toBe(false)
    retireTelemetry(); configureTelemetry({ session_id: "account-b" }, true)
    expect(alignInitialTelemetrySession("provisional", "native-session")).toBe(false)
    emitTelemetry("business.result", { action_name: "message.pin" })
    expect(alignInitialTelemetrySession("account-b", "native-session")).toBe(true)
    installTelemetrySink(event => events.push(event))
    expect(events).toHaveLength(1)
    expect(events[0]?.attributes).toMatchObject({ action_name: "message.pin", session_id: "native-session" })
    retireTelemetry()
    expect(alignInitialTelemetrySession("native-session", "another-session")).toBe(false)
  })
  it("uses business enums and labels unsupported command kinds as a gap", () => {
    expect(resolveActionName("billing.redirect", { action: { kind: "checkout", priceId: "PRIVATE" } })).toBe("billing.checkout.start")
    expect(resolveActionName("bot.command", { input: { kind: "delete-command" } })).toBe("bot.delete")
    expect(resolveActionName("issue.command", { action: { kind: "comment" } })).toBe("issue.comment.create")
    expect(resolveActionName("billing.redirect", { action: { kind: "PRIVATE" } })).toBe("command.unknown")
  })
  it("adopts a gesture into router transport on the same action without a duplicate start", () => {
    const action = beginNavigation("/c/me/machines", "gesture")!
    expect(beginNavigation("/c/me/machines", "transport")).toBe(action)
    expect(events.filter(event => event.name === "action.start")).toHaveLength(1)
    expect(events.filter(event => event.name === "navigation.intent").map(event => event.attributes.phase)).toEqual(["intent", "transport"])
    finishAction(action, "success")
    expect(events.filter(event => event.name === "action.finish")).toHaveLength(1)
  })

})
