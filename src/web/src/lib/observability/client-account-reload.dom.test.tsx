import "fake-indexeddb/auto"
import { afterEach, expect, it, vi } from "vitest"
import { initializeFaro, InternalLoggerLevel, SessionInstrumentation, VolatileSessionsManager } from "@grafana/faro-web-sdk"
import { act, render } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "account-a" } }, isPending: false, error: null }), currentSessionViewer: () => "account-a" }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/perf/react-scan-install", () => ({ installReactScan: vi.fn(async () => {}) }))
const tracingImport = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
})
vi.mock("@grafana/faro-web-tracing", async importOriginal => {
  await tracingImport.ready
  return importOriginal<typeof import("@grafana/faro-web-tracing")>()
})
let mounted: ReturnType<typeof render> | undefined
afterEach(async () => {
  await act(async () => { mounted?.unmount(); mounted = undefined; document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await vi.advanceTimersByTimeAsync(0) })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
it("the actual early instrumentation entry waits for the first actual account Provider and resumes that same owner", async () => {
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/me")
  VolatileSessionsManager.removeUserSession()
  const previousDocument = initializeFaro({
    isolate: true, preventGlobalExposure: true, internalLoggerLevel: InternalLoggerLevel.OFF,
    app: { name: "alook-web" }, transports: [], instrumentations: [new SessionInstrumentation()],
    sessionTracking: { enabled: true, persistent: false, samplingRate: 1, session: { attributes: { alook_account: "account-a" } } },
  })!
  const prior = VolatileSessionsManager.fetchUserSession()!
  previousDocument.instrumentations.remove(...previousDocument.instrumentations.instrumentations)
  const sent: Array<{ meta: { session: { id: string }; user?: { id: string } }; events?: Array<{ name: string }> }> = []
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }) })
  vi.stubGlobal("fetch", fetch)
  const { isTelemetryEligible } = await import("./telemetry")
  await act(async () => { await import("@/instrumentation-client") })
  await vi.advanceTimersByTimeAsync(0)
  expect(isTelemetryEligible()).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
  expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(prior.sessionId)
  const { QueryProvider } = await import("@/app/c/QueryProvider")
  await act(async () => { mounted = render(<QueryProvider userId="account-a"><p>Account content</p></QueryProvider>) })
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true), { timeout: 5000 })
  await act(async () => vi.advanceTimersByTimeAsync(1500))
  expect(sent).toHaveLength(0)
  tracingImport.release()
  await vi.waitFor(() => expect(sent.some(body => body.events?.some(event => event.name === "session_resume"))).toBe(true), { timeout: 5000 })
  expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(prior.sessionId)
  expect(VolatileSessionsManager.fetchUserSession()!.started).toBe(prior.started)
  expect(sent.some(body => body.events?.some(event => event.name === "session_resume"))).toBe(true)
  expect(sent.some(body => body.meta.user?.id === "account-a")).toBe(true)
  for (const body of sent) expect(body.meta.session.id).toBe(prior.sessionId)
  expect(JSON.stringify(sent)).not.toContain("alook_account")
})
