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

it("retains real renderer ownership through late grant and revoke/regrant without collecting denied work", async () => {
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
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  const text = "/c/channels/server-a/text-a", forum = "/c/channels/server-a/forum-a"
  window.history.replaceState(null, "", text)
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
  await act(async () => { bootstrapObservability("web"); view = render(<Root />); await vi.advanceTimersByTimeAsync(3000) })
  expect(sent).toEqual([])
  const originals: Action[] = [], prematurelyDone: boolean[] = []
  for (const [index, grant] of ["late", "regrant"].entries()) {
    if (grant === "regrant") {
      let forward: Action | undefined
      await act(async () => {
        window.history.pushState(null, "", forum); onObservedRouterTransition(forum)
        forward = navigationForHref(forum)
        router.pathname = forum; view!.rerender(<Root />); await vi.advanceTimersByTimeAsync(0)
      })
      expect(forward!.done).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      await act(async () => {
        document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await vi.advanceTimersByTimeAsync(3000)
      })
      const deniedCount = sent.length
      await act(async () => { view!.rerender(<Root />); await vi.advanceTimersByTimeAsync(3000) })
      expect(sent).toHaveLength(deniedCount)
    }
    const beforeGrantCount = sent.length
    await act(async () => { document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted") })
    await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
    await act(async () => { native.release?.(); await vi.advanceTimersByTimeAsync(3000) })
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(beforeGrantCount))
    let original: Action | undefined
    window.addEventListener("popstate", () => { original = navigationForHref(window.location.href) }, { once: true })
    now = 1500 + index * 1000
    await act(async () => { window.history.back(); await vi.advanceTimersByTimeAsync(5) })
    expect(window.location.pathname).toBe(text)
    expect(view!.container.textContent).toBe("forum")
    expect(original).toBeDefined()
    originals.push(original!); prematurelyDone.push(original!.done)
    now += 7
    await act(async () => { onObservedRouterTransition(text) })
    now += 53
    await act(async () => { router.pathname = text; view!.rerender(<Root />); await vi.advanceTimersByTimeAsync(3000) })
    expect(view!.container.textContent).toBe("empty text")
    expect(original!.outcome).toBe("success")
  }
  expect(prematurelyDone).toEqual([false, false])
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
  expect(events.filter(event => event.name === "navigation.ready")).toHaveLength(3)
  expect(events.some(event => event.attributes.navigation_kind === "document")).toBe(false)
  for (const original of originals) {
    const parent = original.span!.spanContext()
    const ready = events.filter(event => event.name === "navigation.ready" && event.attributes.action_id === original.id)
    expect(ready).toHaveLength(1)
    expect(ready[0]?.attributes).toMatchObject({ region: "messages", duration_ms: "60", trace_id: parent.traceId, span_id: parent.spanId })
    expect(spans.filter(span => span.spanId === parent.spanId)).toHaveLength(1)
  }
})
