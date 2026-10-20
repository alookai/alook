import "fake-indexeddb/auto"
import { afterEach, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedRegion } from "./regions"

vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "account-late" } }, isPending: false, error: null }), currentSessionViewer: () => "account-late" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
const sdk = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
})
vi.mock("@grafana/faro-web-tracing", async importOriginal => { await sdk.ready; return importOriginal<typeof import("@grafana/faro-web-tracing")>() })
type ExportedNavigation = { name: string; startTimeUnixNano: string; endTimeUnixNano: string }
type CapturedBody = { traces?: { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportedNavigation[] }> }> } }
function exportedNavigation(sent: readonly CapturedBody[]) {
  return sent.flatMap(body => body.traces?.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)) ?? []).find(span => span.name === "navigation")
}
async function waitForNavigationExport(sent: readonly CapturedBody[]) {
  return vi.waitFor(() => {
    const navigation = exportedNavigation(sent)
    expect(navigation).toBeDefined()
    return navigation!
  }, { timeout: 4000 })
}
let mounted: ReturnType<typeof render> | undefined
afterEach(async () => {
  await act(async () => { mounted?.unmount(); document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await vi.advanceTimersByTimeAsync(0) })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("keeps the actual Provider identity delay distinct from SDK delay and completed document load", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  let now = 100
  const state = vi.spyOn(document, "readyState", "get").mockReturnValue("interactive")
  vi.spyOn(performance, "now").mockImplementation(() => now)
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ responseEnd: 8000, domInteractive: 8100, domContentLoadedEventStart: 8200, domContentLoadedEventEnd: 8250, domComplete: 8500, loadEventStart: 8600, loadEventEnd: 8625, serverTiming: [] } as unknown as PerformanceEntry])
  const sent: Array<{ events?: Array<{ name: string; timestamp: string; attributes: Record<string, string> }>; traces?: { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; startTimeUnixNano: string; endTimeUnixNano: string }> }> }> } }> = []
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }) })
  vi.stubGlobal("fetch", fetch)
  window.history.replaceState(null, "", "/c/me/machines")
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const { bootstrapObservability } = await import("./client")
  await act(async () => { bootstrapObservability("web"); await vi.advanceTimersByTimeAsync(0) })
  expect(fetch).not.toHaveBeenCalled()
  now = 7_200_000
  state.mockReturnValue("complete")
  const { QueryProvider } = await import("@/app/c/QueryProvider")
  function Probe({ ready }: { ready: boolean }) { useObservedRegion("machines", ready, 1); return <p>{ready ? "ready" : "pending"}</p> }
  const tree = (ready: boolean) => <QueryProvider userId="account-late"><Probe ready={ready} /></QueryProvider>
  await act(async () => { mounted = render(tree(false)) })
  now += 166
  await act(async () => mounted!.rerender(tree(true)))
  expect(sent).toEqual([])
  now = 7_201_000
  await act(async () => { sdk.release(); await vi.dynamicImportSettled(); await waitForNavigationExport(sent) })
  const events = sent.flatMap(body => body.events ?? [])
  const observed = events.find(event => event.name === "document.observed")!
  expect(observed.attributes).toMatchObject({ navigation_kind: "document_observation", start_ms: "7200000", duration_ms: "166", document_elapsed_ms: "7200166", document_load_ms: "8625", observation_start_ms: "7200000" })
  expect(events.some(event => event.name === "navigation.ready")).toBe(false)
  const phases = events.filter(event => event.name === "observation.lifecycle")
  expect(phases).toHaveLength(2)
  expect(phases[0]!.attributes).toMatchObject({ phase: "activation", activation_reason: "identity", bootstrap_ms: "100", bootstrap_document_state: "interactive", identity_ms: "7200000", identity_document_state: "complete", activation_ms: "7200000" })
  expect(phases[1]!.attributes).toMatchObject({ phase: "sdk_ready", sdk_import_end_ms: "7201000", sdk_ready_ms: "7201000", page_instance_id: observed.attributes.page_instance_id })
  const navigation = exportedNavigation(sent)!
  expect(Number(BigInt(navigation.endTimeUnixNano) - BigInt(navigation.startTimeUnixNano)) / 1e6).toBeCloseTo(166, 2)
})

it("rejects event-only delivery within the original navigation export budget", async () => {
  vi.useFakeTimers()
  const sent: Array<CapturedBody & { events?: Array<{ name: string }> }> = [{ events: [{ name: "observation.lifecycle" }] }]
  const start = Date.now()
  await expect(waitForNavigationExport(sent)).rejects.toThrow()
  expect(Date.now() - start).toBeLessThanOrEqual(4000)
})

it("accepts a navigation span delivered late within the original export budget", async () => {
  vi.useFakeTimers()
  const sent: CapturedBody[] = []
  const navigation = { name: "navigation", startTimeUnixNano: "1000000", endTimeUnixNano: "167000000" }
  setTimeout(() => sent.push({ traces: { resourceSpans: [{ scopeSpans: [{ spans: [navigation] }] }] } }), 3500)
  const start = Date.now()
  expect(await waitForNavigationExport(sent)).toBe(navigation)
  expect(Date.now() - start).toBeGreaterThanOrEqual(3500)
  expect(Date.now() - start).toBeLessThanOrEqual(4000)
})
