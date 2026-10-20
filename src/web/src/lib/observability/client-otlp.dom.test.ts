import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("the real official OTLP transport receives sanitized traces and logs and aborts its session on withdrawal", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NODE_ENV", "development")
  vi.stubEnv("NEXT_PUBLIC_FARO_OTLP_ENDPOINT", "http://127.0.0.1:14318")
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "0.1.55")
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  const sent: Array<{ url: string; body: Record<string, unknown>; options: RequestInit }> = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, options: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(options.body)), options })
    return new Response(null, { status: 200 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  const { beginNavigation, finishAction } = await import("./context")
  await act(async () => bootstrapObservability("web"))
  await vi.dynamicImportSettled()
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  await vi.advanceTimersByTimeAsync(1500)
  const navigation = beginNavigation("/c/me/machines?secret=DO_NOT_EXPORT")!
  finishAction(navigation, "success", { phase: "primary", region: "machines" })
  emitTelemetry("business.result", { outcome: "success", secret: "DO_NOT_EXPORT" })
  await vi.advanceTimersByTimeAsync(7000)
  await vi.waitFor(() => expect(sent.some(value => value.body.resourceSpans)).toBe(true))
  expect(sent.some(value => value.body.resourceLogs)).toBe(true)
  expect(new Set(sent.map(value => value.url))).toEqual(new Set(["http://127.0.0.1:14318/v1/traces", "http://127.0.0.1:14318/v1/logs"]))
  expect(JSON.stringify(sent.map(value => value.body))).not.toContain("DO_NOT_EXPORT")
  expect(JSON.stringify(sent.map(value => value.body))).toContain("navigation.ready")
  for (const value of sent) expect(value.options.credentials).toBe("omit")
  const signals = sent.map(value => value.options.signal!)
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  expect(signals.every(signal => signal.aborted)).toBe(true)
  const before = sent.length
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(7000)
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(before)
})
