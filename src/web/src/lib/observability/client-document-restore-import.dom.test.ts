import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const pending = vi.hoisted(() => {
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  return { ready, release }
})
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  await pending.ready
  return importOriginal<typeof import("@grafana/faro-web-sdk")>()
})
afterEach(async () => {
  await act(async () => { document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await vi.advanceTimersByTimeAsync(0) })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("does not install or backfill a document generation whose SDK import resolves after document retirement", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  window.history.replaceState(null, "", "/")
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  const sent: Array<{ events?: Array<{ name: string; attributes: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: RequestInit) => {
    if (String(url) === "https://collector.example/collect/public" && options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible, telemetryGeneration } = await import("./telemetry")
  const { navigationForHref, startAction, finishAction } = await import("./context")
  await act(async () => { bootstrapObservability("web") })
  const initial = navigationForHref("/")!
  expect(initial).toBeDefined()
  const generation = telemetryGeneration()
  const retired = startAction("message.edit")!
  emitTelemetry("business.result", { action_id: retired.id, outcome: "success" })
  await act(async () => { window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })) })
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  await act(async () => { window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })); pending.release() })
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  finishAction(retired, "success")
  expect(initial.done).toBe(true)
  expect(telemetryGeneration()).toBeGreaterThan(generation)
  expect(JSON.stringify(sent)).not.toContain(initial.id)
  expect(JSON.stringify(sent)).not.toContain(retired.id)
  expect(sent.flatMap(body => body.events ?? []).some(event => event.attributes.navigation_kind === "document")).toBe(false)
  const current = startAction("message.pin")!
  expect(current.span).toBeDefined()
  finishAction(current, "success")
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(sent.flatMap(body => body.events ?? []).some(event => event.name === "action.finish" && event.attributes.action_id === current.id)).toBe(true)
})
