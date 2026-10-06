import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("retires an initial visit revoked while waiting for identity instead of backfilling it on regrant", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const sent: Array<{ events?: Array<{ name: string; attributes: Record<string, string> }> }> = []
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal("fetch", fetch)
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/me/bots")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { navigationForHref } = await import("./context")
  await act(async () => { bootstrapObservability("web"); await vi.advanceTimersByTimeAsync(0) })
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
    setTelemetryUser("account-a")
    document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted")
    await vi.advanceTimersByTimeAsync(1500)
  })
  expect(navigationForHref(window.location.href)).toBeUndefined()
  expect(sent.flatMap(body => body.events ?? []).some(event => event.name === "navigation.intent")).toBe(false)
})
