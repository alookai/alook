import { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedQueryRegion } from "./query-regions"

const native = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  await new Promise<void>(resolve => { native.release = resolve })
  return real
})
vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams(window.location.search) }))
let view: ReturnType<typeof render> | undefined
let client: QueryClient | undefined
afterEach(async () => {
  await act(async () => { view?.unmount(); document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); client?.clear(); await vi.advanceTimersByTimeAsync(0) })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("binds the initial navigation before ready and parents a real native HTTP span", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  let now = 240
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const sent: unknown[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
    if (String(url) === "https://collector.example/collect/public" && options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/channels/server-a/channel-a")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { navigationForHref } = await import("./context")
  client = new QueryClient()
  let resolve: ((value: never[]) => void) | undefined
  const data = new Promise<never[]>(done => { resolve = done })
  function Content() {
    const query = useQuery({ queryKey: ["messages"], queryFn: () => data, staleTime: Infinity })
    useObservedQueryRegion("messages", query, query.data?.length)
    return <p>{query.isPending ? "loading" : "empty"}</p>
  }
  function Root() {
    useLayoutEffect(() => setTelemetryUser("account-a"), [])
    return <QueryClientProvider client={client!}><Content /></QueryClientProvider>
  }
  await act(async () => { bootstrapObservability("web"); view = render(<Root />) })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  const navigation = navigationForHref(window.location.href)!
  expect(navigation.span).toBeUndefined()
  now = 900
  await act(async () => { native.release?.(); await vi.advanceTimersByTimeAsync(1500) })
  expect(navigation.span?.isRecording()).toBe(true)
  expect(navigationForHref(window.location.href)).toBe(navigation)
  const parent = navigation.span!.spanContext()
  const { apiFetchResponse } = await import("@/lib/api/client")
  await apiFetchResponse("/api/agents", { observation: { action: navigation, reason: "router" } })
  now = 1250
  await act(async () => { resolve?.([]); await vi.advanceTimersByTimeAsync(0); view!.rerender(<Root />) })
  expect(navigation.done).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  const spans: Record<string, unknown>[] = []
  const events: Array<{ name: string; attributes: Record<string, string> }> = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.spanId === "string") spans.push(record)
    if (Array.isArray(record.events)) events.push(...record.events as typeof events)
    for (const child of Object.values(record)) visit(child)
  }
  visit(sent)
  const navigationSpan = spans.filter(span => span.spanId === parent.spanId)
  expect(navigationSpan).toHaveLength(1)
  expect(navigationSpan[0]).toMatchObject({ name: "navigation", traceId: parent.traceId })
  expect(Number(BigInt(String(navigationSpan[0]!.endTimeUnixNano)) - BigInt(String(navigationSpan[0]!.startTimeUnixNano))) / 1e6).toBeCloseTo(1250, 2)
  expect(spans.filter(span => span.parentSpanId === parent.spanId)).toMatchObject([{ name: "GET /api/agents", traceId: parent.traceId }])
  const ready = events.filter(event => event.name === "navigation.ready")
  expect(ready).toHaveLength(1)
  expect(ready[0]?.attributes).toMatchObject({ navigation_kind: "document", start_ms: "0", duration_ms: "1250", trace_id: parent.traceId, span_id: parent.spanId, action_id: navigation.id })
  expect(events.filter(event => event.name.startsWith("request.")).every(event => event.attributes.trace_id === parent.traceId && event.attributes.span_id === parent.spanId)).toBe(true)
})
