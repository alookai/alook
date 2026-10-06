import { useLayoutEffect } from "react"
import { usePathname } from "next/navigation"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedQueryRegion } from "./query-regions"
import type { Action } from "./context"

const router = vi.hoisted(() => ({ pathname: "/" }))
const native = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  await new Promise<void>(resolve => { native.release = resolve })
  return real
})
vi.mock("next/navigation", () => ({ usePathname: () => router.pathname, useSearchParams: () => new URLSearchParams() }))
let view: ReturnType<typeof render> | undefined
let client: QueryClient | undefined
afterEach(async () => {
  await act(async () => { view?.unmount(); document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); client?.clear(); await vi.advanceTimersByTimeAsync(0) })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("keeps one original Back span until the text frame commits, ignoring the outgoing ready forum", async () => {
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
  const text = "/c/channels/server-a/text-a", forum = "/c/channels/server-a/forum-a"
  const textHref = text + "?q=hello%20there"
  window.history.replaceState(null, "", textHref)
  window.history.pushState(null, "", forum)
  router.pathname = forum
  const { bootstrapObservability, setTelemetryUser, onObservedRouterTransition } = await import("./client")
  const { commitNavigation, navigationForHref } = await import("./context")
  client = new QueryClient()
  client.setQueryData([forum], [{ id: "post-a" }]); client.setQueryData([text], [])
  function Content() {
    const pathname = usePathname()
    const query = useQuery({ queryKey: [pathname], queryFn: async () => [], staleTime: Infinity })
    useObservedQueryRegion(pathname === forum ? "forum" : "messages", query, query.data?.length)
    return <p>{pathname === forum ? "forum" : "empty text"}</p>
  }
  function Root() {
    const pathname = usePathname()
    useLayoutEffect(() => setTelemetryUser("account-a"), [])
    useLayoutEffect(() => commitNavigation(pathname), [pathname])
    return <QueryClientProvider client={client!}><Content /></QueryClientProvider>
  }
  await act(async () => { bootstrapObservability("web"); view = render(<Root />) })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  await act(async () => { native.release?.(); await vi.advanceTimersByTimeAsync(3000) })
  let original: Action | undefined
  window.addEventListener("popstate", () => { original = navigationForHref(window.location.href) }, { once: true })
  now = 1500
  await act(async () => { window.history.back(); await vi.advanceTimersByTimeAsync(5) })
  expect(window.location.pathname).toBe(text)
  expect(view!.container.textContent).toBe("forum")
  expect(original).toBeDefined()
  expect(original!.done).toBe(false)
  const parent = original!.span!.spanContext()
  now = 1507
  await act(async () => { onObservedRouterTransition(textHref) })
  expect(navigationForHref(textHref)).toBe(original)
  now = 1560
  await act(async () => { router.pathname = text; view!.rerender(<Root />); await vi.advanceTimersByTimeAsync(0) })
  expect(view!.container.textContent).toBe("empty text")
  expect(original!.done).toBe(true)
  await act(async () => { view!.rerender(<Root />); await vi.advanceTimersByTimeAsync(3000) })
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
  const starts = events.filter(event => event.name === "action.start" && event.attributes.navigation_kind === "route")
  expect(starts).toHaveLength(1)
  expect(starts[0]?.attributes).toMatchObject({ action_id: original!.id, start_ms: "1500" })
  const ready = events.filter(event => event.name === "navigation.ready" && event.attributes.navigation_kind === "route")
  expect(ready).toHaveLength(1)
  expect(ready[0]?.attributes).toMatchObject({ region: "messages", action_id: original!.id, navigation_id: original!.navigationId, start_ms: "1500", duration_ms: "60", trace_id: parent.traceId, span_id: parent.spanId })
  const navigationSpans = spans.filter(span => span.name === "navigation")
  expect(navigationSpans).toHaveLength(2)
  const back = navigationSpans.find(span => span.spanId === parent.spanId)!
  expect(back.traceId).toBe(parent.traceId)
  expect(Number(BigInt(String(back.endTimeUnixNano)) - BigInt(String(back.startTimeUnixNano))) / 1e6).toBeCloseTo(60, 2)
})
