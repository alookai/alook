import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("exports actual native Faro events with only the Collector configured", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", undefined)
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", undefined)
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  const sent: Array<{ meta: { app: Record<string, unknown>; sdk: { name: string; version: string } }; events?: Array<{ name: string; attributes?: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  await act(async () => { bootstrapObservability("blog"); await Promise.resolve() })
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  await vi.waitFor(() => expect(sent.some(body => body.events?.some(event => event.name === "session_start"))).toBe(true), { timeout: 5000 })
  expect(sent.some(body => body.events?.some(event => event.name === "business.result"))).toBe(true)
  for (const body of sent) {
    expect(body.meta.sdk).toEqual({ name: "faro-web", version: "2.12.1" })
    expect(body.meta.app).not.toHaveProperty("environment")
    expect(body.meta.app).not.toHaveProperty("release")
    expect(body.meta.app).not.toHaveProperty("version")
    for (const event of body.events ?? []) {
      expect(event.attributes).not.toHaveProperty("environment")
      expect(event.attributes).not.toHaveProperty("release")
    }
  }
})
