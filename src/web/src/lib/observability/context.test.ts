import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bindCommandAction, beginNavigation, clearActions, commandObservation, finishAction, startAction, installActionSpans, navigationForHref } from "./context"
import { configureTelemetry, emitTelemetry, installTelemetrySink, retireTelemetry, telemetryGeneration } from "./telemetry"
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
  it("uses business enums and labels unsupported command kinds as a gap", () => {
    expect(resolveActionName("billing.redirect", { action: { kind: "checkout", priceId: "PRIVATE" } })).toBe("billing.checkout.start")
    expect(resolveActionName("bot.command", { input: { kind: "delete-command" } })).toBe("bot.delete")
    expect(resolveActionName("issue.command", { action: { kind: "comment" } })).toBe("issue.comment.create")
    expect(resolveActionName("billing.redirect", { action: { kind: "PRIVATE" } })).toBe("command.unknown")
  })
})
