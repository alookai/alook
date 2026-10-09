import { afterEach, expect, it, vi } from "vitest"
import { announceAnalyticsConsent } from "../analytics-consent"
import { act } from "@/test/react-dom-harness"

afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("observes native RSC headers and streamed completion and links a click to its real prefetch context", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40)); vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  let body!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }), { headers: { "content-type": "text/x-component", "cf-ray": "a".repeat(16) + "-SJC" } })
  const clone = vi.spyOn(response, "clone")
  const sent: unknown[] = []
  let injected: Headers | undefined
  const fetchFailure = new Error("PRIVATE failed RSC fetch")
  const originalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://collector.example/")) {
      if (init?.body) sent.push(JSON.parse(String(init.body)))
      return new Response(null, { status: 204 })
    }
    injected = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (String(input).includes("FAILED_PRIVATE")) throw fetchFailure
    return response
  })
  vi.stubGlobal("fetch", originalFetch)
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/me")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { beginNavigationPrefetch, beginNavigation, finishAction } = await import("./context")
  const { isTelemetryEligible } = await import("./telemetry")
  await act(async () => { bootstrapObservability("web"); setTelemetryUser("account-a"); await vi.advanceTimersByTimeAsync(1500) })
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  const probe = beginNavigationPrefetch("/c/me/bots")!
  await vi.waitFor(() => expect(probe.span).toBeDefined())
  const href = "/c/channels/server-a/channel-a"
  const prefetch = beginNavigationPrefetch(href)!
  const parent = prefetch.span!.spanContext()
  const returned = await window.fetch(window.location.origin + href + "?_rsc=PRIVATE", { headers: { "next-router-prefetch": "1" } })
  expect(returned).toBe(response)
  expect(returned.bodyUsed).toBe(false)
  expect(clone).toHaveBeenCalledOnce()
  expect(injected?.get("traceparent")).toMatch(new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`))
  await vi.advanceTimersByTimeAsync(1500)
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  const spans: Array<Record<string, unknown>> = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.spanId === "string" && typeof record.name === "string") spans.push(record)
    if (Array.isArray(record.events)) events.push(...record.events as typeof events)
    for (const child of Object.values(record)) visit(child)
  }
  visit(sent)
  const requests = () => events.filter(event => event.attributes.action_id === prefetch.id && event.name.startsWith("request."))
  expect(requests().map(event => event.name)).toEqual(["request.start", "request.headers"])
  const navigation = beginNavigation(href)!
  expect(navigation.prefetch).toBe(prefetch)
  expect(navigation.span!.spanContext().traceId).not.toBe(parent.traceId)
  body.enqueue(new TextEncoder().encode("PRIVATE RSC content")); body.close()
  expect(await returned.text()).toBe("PRIVATE RSC content")
  await vi.advanceTimersByTimeAsync(0)
  finishAction(navigation, "success", { phase: "primary", region: "messages" })
  await vi.advanceTimersByTimeAsync(5000)
  events.length = 0; spans.length = 0; visit(sent)
  expect(requests().map(event => event.name)).toEqual(["request.start", "request.headers", "request.finish"])
  expect(requests().at(-1)?.attributes).toMatchObject({ phase: "body", outcome: "observed", request_kind: "rsc" })
  const http = spans.find(span => span.parentSpanId === parent.spanId)!
  expect(http).toMatchObject({ traceId: parent.traceId })
  expect(requests().at(-1)?.attributes.span_id).toBe(http.spanId)
  expect(spans.find(span => span.spanId === navigation.span!.spanContext().spanId)?.links)
    .toEqual([{ traceId: parent.traceId, spanId: parent.spanId, attributes: [], droppedAttributesCount: 0 }])
  expect(JSON.stringify(sent)).not.toContain("PRIVATE")
  expect(JSON.stringify(sent)).toContain("a".repeat(40))
  expect(clone).toHaveBeenCalledOnce()
  const failedAction = beginNavigation("/c/me/friends")!
  await expect(window.fetch(window.location.origin + "/c/me/friends?_rsc=FAILED_PRIVATE")).rejects.toBe(fetchFailure)
  finishAction(failedAction, "error")
  await vi.advanceTimersByTimeAsync(5000)
  events.length = 0; spans.length = 0; visit(sent)
  const failedRequests = events.filter(event => event.attributes.action_id === failedAction.id && event.name.startsWith("request."))
  expect(failedRequests.map(event => event.name)).toEqual(["request.start", "request.finish"])
  expect(failedRequests.at(-1)?.attributes).toMatchObject({ phase: "headers", outcome: "error", request_kind: "rsc" })
  expect(JSON.stringify(sent)).not.toContain("PRIVATE")
  expect(clone).toHaveBeenCalledOnce()
  const activeFetch = window.fetch
  const delivered = sent.length
  document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  expect(window.fetch).not.toBe(activeFetch)
  await window.fetch(window.location.origin + href + "?_rsc=PRIVATE", { headers: { "next-router-prefetch": "1" } })
  expect(injected?.has("traceparent")).toBe(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent).toHaveLength(delivered)
  expect(clone).toHaveBeenCalledOnce()
})
