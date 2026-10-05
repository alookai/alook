import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
afterEach(() => { document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it("rejects malformed collector build metadata before SDK startup or outbound telemetry", async () => {
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "http://[")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  await act(async () => { bootstrapObservability("web"); await Promise.resolve() })
  emitTelemetry("business.result", { outcome: "success" })
  expect(isTelemetryEligible()).toBe(false)
  expect(fetch).not.toHaveBeenCalled()
})
