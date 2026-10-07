import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { observeQueryClient, disposeQueryDiagnostics } from "./query-observer"
import { abortObserved, createObservedAbortController, observeAbortDeadline, observeAccountQueryCancellation, observeQuerySignal } from "./cancellation"
import { startRequest, finishRequest } from "./requests"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "./telemetry"
import { withConversationReadDeadline } from "@/lib/community/conversation-read"

const events: Array<{ name: string; attributes: Record<string, string> }> = []
let client: QueryClient
beforeEach(() => { events.length = 0; configureTelemetry({ session_id: "cancel-session" }, true); installTelemetrySink(event => events.push(event)); client = observeQueryClient(new QueryClient({ defaultOptions: { queries: { retry: false } } })) })
afterEach(() => { disposeQueryDiagnostics(client); client.clear(); retireTelemetry(); vi.useRealTimers() })
function subscribe(key: string) {
  const options = { queryKey: [key], queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const query = client.getQueryCache().find({ queryKey: [key], exact: true })!
    const stop = observeQuerySignal(signal, query)
    const request = startRequest("/api/community/channels/private/threads", { signal })
    try { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("private reason", "AbortError")), { once: true })) }
    finally { finishRequest(request, "cancelled", "body"); stop() }
    return null
  } }
  const first = new QueryObserver(client, options), second = new QueryObserver(client, options)
  return [first.subscribe(() => {}), second.subscribe(() => {})] as const
}
it("distinguishes consumed-signal final observer cancellation from explicit account cancellation", async () => {
  const [one, two] = subscribe("private-one")
  one()
  expect(events.filter(event => event.name === "request.abort")).toHaveLength(0)
  two(); await Promise.resolve(); await Promise.resolve()
  const abort = events.find(event => event.name === "request.abort")!.attributes
  expect(abort.abort_cause).toBe("query_signal")
  expect(events.some(event => event.attributes.query_id === abort.query_id && event.attributes.query_boundary === "observerRemoved" && event.attributes.observer_count === "0")).toBe(true)
  const [three, four] = subscribe("private-two")
  observeAccountQueryCancellation(client.getQueryCache().getAll().filter(query => query.state.fetchStatus === "fetching"))
  await client.cancelQueries({ queryKey: ["private-two"] })
  const account = events.filter(event => event.name === "request.abort").at(-1)!.attributes
  expect(account.abort_cause).toBe("account_retire")
  expect(events.some(event => event.attributes.query_id === account.query_id && event.attributes.query_boundary === "account_cancel")).toBe(true)
  expect(events.some(event => event.attributes.query_id === account.query_id && event.attributes.query_boundary === "observerRemoved")).toBe(false)
  three(); four()
  expect(JSON.stringify(events)).not.toContain("private")
})
it("records the earlier owner deadline and the later HTTP clock without changing abort reasons", async () => {
  vi.useFakeTimers()
  const result = withConversationReadDeadline(undefined, async signal => {
    await new Promise(resolve => setTimeout(resolve, 14_990))
    const request = startRequest("/api/agents", { signal })
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    finishRequest(request, "cancelled", "body")
  })
  const rejected = expect(result).rejects.toMatchObject({ name: "ConversationReadTimeoutError" })
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  const owner = events.find(event => event.name === "request.boundary" && event.attributes.abort_phase === "timer_start")!.attributes
  const abort = events.find(event => event.name === "request.abort")!.attributes
  expect(abort.abort_owner_id).toBe(owner.abort_owner_id)
  expect(abort.abort_cause).toBe("deadline")
  expect(Number(abort.duration_ms)).toBeLessThan(15_000)
})
it("handles already-aborted signals once, cleans finished listeners and rejects retired observations", () => {
  const controller = new AbortController(), reason = new DOMException("private", "AbortError")
  observeAbortDeadline(controller, 5000)
  abortObserved(controller, "view_cleanup", reason)
  expect(controller.signal.reason).toBe(reason)
  const request = startRequest("/api/agents", { signal: controller.signal })
  expect(events.filter(event => event.name === "request.abort")).toHaveLength(1)
  finishRequest(request, "cancelled", "headers")
  const next = new AbortController(), active = startRequest("/api/agents", { signal: next.signal })
  finishRequest(active, "success", "headers")
  const count = events.length
  next.abort()
  expect(events).toHaveLength(count)
  const old = new AbortController()
  observeAbortDeadline(old, 5000)
  startRequest("/api/agents", { signal: old.signal })
  retireTelemetry(); configureTelemetry({ session_id: "new-session" }, true); installTelemetrySink(event => events.push(event))
  const before = events.length
  abortObserved(old, "deadline")
  expect(events).toHaveLength(before)
})
it("fences non-deadline owner aborts and keeps unknown controller ownership unreported", () => {
  const old = createObservedAbortController(), unknown = new AbortController()
  retireTelemetry(); configureTelemetry({ session_id: "new-session" }, true); installTelemetrySink(event => events.push(event))
  const count = events.length, reason = new DOMException("private", "AbortError")
  abortObserved(old, "view_cleanup", reason)
  abortObserved(unknown, "view_retire", reason)
  expect(old.signal.reason).toBe(reason)
  expect(unknown.signal.reason).toBe(reason)
  expect(events).toHaveLength(count)
})
it("does not attribute old Query cancellation and observer removal to a replacement session", async () => {
  const [one, two] = subscribe("private-old-query")
  retireTelemetry(); configureTelemetry({ session_id: "replacement-session" }, true); installTelemetrySink(event => events.push(event))
  const count = events.length
  observeAccountQueryCancellation(client.getQueryCache().getAll())
  await client.cancelQueries()
  one(); two(); client.clear()
  expect(events).toHaveLength(count)
})
