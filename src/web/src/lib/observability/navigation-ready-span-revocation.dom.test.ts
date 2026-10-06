import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const native = vi.hoisted(() => ({ release: undefined as (() => void) | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  await new Promise<void>(resolve => { native.release = resolve })
  return real
})
afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("does not bind or export the completed document after consent and account retirement during import", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const sent: unknown[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/c/me/bots")
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { navigationForHref, finishAction } = await import("./context")
  await act(async () => { bootstrapObservability("web"); setTelemetryUser("account-a") })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  const original = navigationForHref(window.location.href)!
  finishAction(original, "success", { phase: "primary", region: "bots" })
  expect(original.span).toBeUndefined()
  await act(async () => {
    document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied")
    setTelemetryUser("account-b")
    document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted")
    native.release?.(); await vi.advanceTimersByTimeAsync(4000)
  })
  expect(sent.length).toBeGreaterThan(0)
  expect(original.span).toBeUndefined()
  expect(JSON.stringify(sent)).not.toContain(original.id)
  expect(JSON.stringify(sent)).not.toContain("navigation.ready")
  expect(JSON.stringify(sent)).not.toContain("account-a")
  expect(JSON.stringify(sent)).toContain("account-b")
})
