import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

vi.mock("@alook/shared", () => ({ isTauri: () => true, isMobile: () => true }))

afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("exports canonical native entry and frontend version on real SDK and business payloads, then stops on withdrawal", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "0.1.44")
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  const sent: Array<{ meta: { app: Record<string, unknown>; session: { attributes: Record<string, string> } }; events?: Array<{ name: string; attributes?: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  await act(async () => { bootstrapObservability("web"); await Promise.resolve() })
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  emitTelemetry("business.result", { outcome: "success", frontend_surface: "web", client_platform: "browser", app_version: "9.9.9" })
  await vi.advanceTimersByTimeAsync(1500)
  await vi.waitFor(() => expect(sent.some(body => body.events?.some(event => event.name === "session_start"))).toBe(true), { timeout: 5000 })
  expect(sent.some(body => body.events?.some(event => event.name === "business.result"))).toBe(true)
  const identity = { frontend_surface: "webview", client_platform: "mobile", app_version: "0.1.44" }
  for (const body of sent) {
    expect(body.meta.app).toMatchObject({ version: "0.1.44", release: "a".repeat(40), environment: "qa" })
    expect(body.meta.session.attributes).toMatchObject(identity)
    for (const event of body.events ?? []) expect(event.attributes).toMatchObject(identity)
  }
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  const before = sent.length
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(3000)
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(before)
})
