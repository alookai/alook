import { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedRegion } from "./regions"
import { observationEpoch } from "./clock"

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

it("retains real ready time before a delayed SDK and records each later route once through native Faro", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", undefined); vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", undefined)
  let now = 240
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  type Exported = { name: string; timestamp: string; attributes: Record<string, string> }
  const sent: Array<{ events?: Exported[]; traces?: { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; spanId: string; startTimeUnixNano: string; endTimeUnixNano: string }> }> }> } }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/channels/server-a/channel-a")
  const { bootstrapObservability, setTelemetryUser, onObservedRouterTransition } = await import("./client")
  const { navigationForHref } = await import("./context")
  client = new QueryClient()
  client.setQueryData(["messages"], []); client.setQueryData(["forum"], [])
  function Content({ region }: { region: "messages" | "forum" }) {
    const query = useQuery({ queryKey: [region], queryFn: async () => [], staleTime: Infinity })
    useObservedRegion(region, !query.isPending && query.data !== undefined, query.data?.length)
    return <p>{region}: {query.isPending ? "loading" : "empty"}</p>
  }
  function Root({ region }: { region: "messages" | "forum" }) {
    useLayoutEffect(() => setTelemetryUser("account-a"), [])
    return <QueryClientProvider client={client!}><Content region={region} /></QueryClientProvider>
  }
  const readyAt = Math.floor(observationEpoch())
  await act(async () => { bootstrapObservability("web"); view = render(<Root region="messages" />) })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  expect(navigationForHref(window.location.href)).toBeUndefined()
  expect(sent).toEqual([])
  now = 900
  await act(async () => { native.release?.(); await vi.advanceTimersByTimeAsync(1500) })
  const exported = () => sent.flatMap(body => body.events ?? [])
  const metrics = () => exported().filter(event => event.name === "navigation.ready")
  expect(metrics()).toHaveLength(1)
  expect(metrics()[0]?.attributes).toMatchObject({ navigation_kind: "document", start_ms: "0", duration_ms: "240", region: "messages", outcome: "success" })
  expect(Date.parse(metrics()[0]!.timestamp)).toBe(readyAt)
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  const parent = sent.flatMap(body => body.traces?.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)) ?? []).filter(span => span.name === "navigation")
  expect(parent).toHaveLength(1)
  expect(metrics()[0]?.attributes).toMatchObject({ trace_id: parent[0]!.traceId, span_id: parent[0]!.spanId })
  expect(Number(BigInt(parent[0]!.endTimeUnixNano) - BigInt(parent[0]!.startTimeUnixNano)) / 1e6).toBeCloseTo(240, 2)
  expect(Number(BigInt(parent[0]!.startTimeUnixNano)) / 1e6).toBeCloseTo(performance.timeOrigin, 2)
  expect(exported().filter(event => event.attributes.action_id === metrics()[0]!.attributes.action_id).every(event => event.attributes.trace_id === parent[0]!.traceId && event.attributes.span_id === parent[0]!.spanId)).toBe(true)
  expect(exported().filter(event => event.name === "action.start" && event.attributes.action_name === "navigation")).toHaveLength(1)
  await act(async () => {
    now = 1700
    onObservedRouterTransition("/c/channels/server-a/forum-a")
    window.history.pushState(null, "", "/c/channels/server-a/forum-a")
    now = 1750
    view!.rerender(<Root region="forum" />)
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(metrics()).toHaveLength(2)
  expect(metrics()[1]?.attributes).toMatchObject({ navigation_kind: "route", start_ms: "1700", duration_ms: "50", region: "forum", outcome: "success" })
  expect(metrics()[1]?.attributes.action_id).not.toBe(metrics()[0]?.attributes.action_id)
  await act(async () => { now = 2300; client!.setQueryData(["forum"], []); view!.rerender(<Root region="forum" />); await vi.advanceTimersByTimeAsync(1500) })
  expect(metrics()).toHaveLength(2)
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
    onObservedRouterTransition("/c/me/bots")
    await vi.advanceTimersByTimeAsync(0)
    now = 3000
    document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted")
    await vi.advanceTimersByTimeAsync(1500)
  })
  expect(metrics()).toHaveLength(2)
})
