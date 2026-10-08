import { useLayoutEffect } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { Faro } from "@grafana/faro-web-sdk"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedQueryRegion } from "./query-regions"

const native = vi.hoisted(() => ({ faro: undefined as Faro | undefined }))
const router = vi.hoisted(() => ({ pathname: "/" }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => { native.faro = real.initializeFaro(...args); return native.faro } }
})
vi.mock("next/navigation", () => ({ usePathname: () => router.pathname, useSearchParams: () => new URLSearchParams() }))
let view: ReturnType<typeof render> | undefined
let queryClient: QueryClient | undefined
afterEach(async () => {
  await act(async () => {
    view?.unmount(); queryClient?.clear()
    document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
    await vi.advanceTimersByTimeAsync(0)
  })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("retires the old document before native resume, then exports one original Back in a fresh consent session", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  let now = 200
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  type Event = { name: string; attributes: Record<string, string> }
  type Body = { meta: { session: { id: string } }; events?: Event[] }
  const sent: Body[] = []
  let collectorStatus = 204
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
    if (String(url) === "https://collector.example/collect/public" && options?.body) {
      sent.push(JSON.parse(String(options.body)))
    }
    return new Response(null, { status: collectorStatus })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const text = "/c/channels/server-a/text-a", forum = "/c/channels/server-a/forum-a"
  window.history.replaceState(null, "", text); window.history.pushState(null, "", forum)
  router.pathname = forum
  const { bootstrapObservability, setTelemetryUser, onObservedRouterTransition } = await import("./client")
  const { commitNavigation, navigationForHref, startAction, finishAction } = await import("./context")
  const { emitTelemetry, isTelemetryEligible, telemetryGeneration } = await import("./telemetry")
  const { VolatileSessionsManager } = await import("@grafana/faro-web-sdk")
  queryClient = new QueryClient()
  queryClient.setQueryData([forum], [{ id: "post-a" }]); queryClient.setQueryData([text], [])
  function Content() {
    const query = useQuery({ queryKey: [router.pathname], queryFn: async () => [], staleTime: Infinity })
    useObservedQueryRegion(router.pathname === forum ? "forum" : "messages", query, query.data?.length)
    return <p>{router.pathname === forum ? "forum" : "empty text"}</p>
  }
  function Root() {
    const pathname = router.pathname
    useLayoutEffect(() => setTelemetryUser("account-a"), [])
    useLayoutEffect(() => commitNavigation(pathname), [pathname])
    return <QueryClientProvider client={queryClient!}><Content /></QueryClientProvider>
  }
  await act(async () => { bootstrapObservability("web"); view = render(<Root />) })
  await act(async () => { await vi.waitFor(() => expect(native.faro?.api.getSession()?.id).toBeTruthy()) })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  const originalSession = native.faro!.api.getSession()!.id
  const initialReady = sent.flatMap(body => body.events ?? []).filter(event => event.name === "navigation.ready")
  expect(initialReady).toHaveLength(1)
  expect(initialReady[0]?.attributes.navigation_kind).toBe("document")
  await act(async () => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })); await vi.advanceTimersByTimeAsync(3000) })
  expect(native.faro!.api.getSession()!.id).toBe(originalSession)
  expect(sent.flatMap(body => body.events ?? []).filter(event => event.name === "navigation.ready")).toHaveLength(1)

  const generation = telemetryGeneration()
  const retired = startAction("message.edit")!
  collectorStatus = 429
  const beforeRetry = sent.length
  emitTelemetry("business.result", { action_id: retired.id, outcome: "success" })
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(sent.length).toBeGreaterThan(beforeRetry)
  const beforeHide = sent.length
  await act(async () => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
  const inactiveAfterHide = !isTelemetryEligible()
  collectorStatus = 204
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  VolatileSessionsManager.removeUserSession()
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
    await vi.advanceTimersByTimeAsync(3000)
  })
  const restoredSession = native.faro!.api.getSession()!.id
  expect(restoredSession).not.toBe(originalSession)
  expect(inactiveAfterHide).toBe(true)
  expect(telemetryGeneration()).toBeGreaterThan(generation)
  expect(retired.done).toBe(true)
  expect(isTelemetryEligible()).toBe(true)
  finishAction(retired, "success")

  now = 1600
  await act(async () => { window.history.back(); await vi.advanceTimersByTimeAsync(5) })
  const original = navigationForHref(text)!
  expect(original).toBeDefined()
  expect(original.done).toBe(false)
  expect(view!.container.textContent).toBe("forum")
  const parent = original.span!.spanContext()
  now += 5
  await act(async () => { onObservedRouterTransition(text) })
  expect(navigationForHref(text)).toBe(original)
  now += 50
  await act(async () => { router.pathname = text; view!.rerender(<Root />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(view!.container.textContent).toBe("empty text")
  const restored = sent.slice(beforeHide)
  expect(restored.every(body => body.meta.session.id === restoredSession)).toBe(true)
  expect(JSON.stringify(restored)).not.toContain(retired.id)
  const events = restored.flatMap(body => body.events ?? [])
  expect(events.some(event => event.attributes.navigation_kind === "document")).toBe(false)
  const ready = events.filter(event => event.name === "navigation.ready")
  expect(ready).toHaveLength(1)
  expect(ready[0]?.attributes).toMatchObject({ action_id: original.id, navigation_id: original.navigationId, session_id: restoredSession, trace_id: parent.traceId, span_id: parent.spanId, start_ms: "1600", duration_ms: "55", region: "messages", phase: "primary" })
  const spans: Record<string, unknown>[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.spanId === "string") spans.push(record)
    for (const child of Object.values(record)) visit(child)
  }
  visit(restored)
  expect(spans.filter(span => span.spanId === parent.spanId)).toHaveLength(1)

  await act(async () => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
  const suspendedCount = sent.length
  await act(async () => { announceAnalyticsConsent("granted"); await vi.advanceTimersByTimeAsync(3000) })
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(suspendedCount)
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  VolatileSessionsManager.removeUserSession()
  const deniedCount = sent.length
  await act(async () => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))
    onObservedRouterTransition(forum); view!.rerender(<Root />)
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(deniedCount)
  await act(async () => { document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted"); await vi.advanceTimersByTimeAsync(3000) })
  expect(native.faro!.api.getSession()!.id).not.toBe(restoredSession)
  expect(sent.slice(deniedCount).flatMap(body => body.events ?? []).some(event => event.attributes.navigation_kind === "document")).toBe(false)
})
