import type { Faro } from "@grafana/faro-web-sdk"
import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const native = vi.hoisted(() => ({ faro: undefined as Faro | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => {
    native.faro = real.initializeFaro(...args)
    return native.faro
  } }
})
afterEach(async () => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("collects fresh public document vitals, stops at private navigation and denial, then resumes public collection", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  document.cookie = "alook_analytics_consent=; max-age=0; path=/"
  window.history.replaceState(null, "", "/")
  const sent: Array<{ measurements?: Array<{ values: Record<string, number> }>; events?: Array<{ name: string; attributes?: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  }))
  const { bootstrapObservability, onObservedRouterTransition, onObservedRouteCommit } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  await act(async () => { bootstrapObservability("web"); await Promise.resolve() })
  await vi.waitFor(() => expect(native.faro).toBeDefined())
  await vi.advanceTimersByTimeAsync(1500)
  expect(isTelemetryEligible()).toBe(true)
  native.faro!.api.pushMeasurement({ type: "web-vitals", values: { lcp: 125, fcp: 50, ttfb: 25 } })
  await vi.advanceTimersByTimeAsync(1500)
  expect(sent.flatMap(body => body.measurements ?? []).some(row => row.values.lcp === 125)).toBe(true)
  expect(document.cookie).not.toContain("alook_analytics_consent")

  const privateLink = document.createElement("a")
  privateLink.href = "/c/me/friends"
  privateLink.addEventListener("click", event => event.preventDefault())
  document.body.append(privateLink)
  privateLink.click()
  await vi.advanceTimersByTimeAsync(1500)
  expect(JSON.stringify(sent)).not.toContain("/c/me/friends")
  privateLink.remove()
  onObservedRouterTransition("/c/me/friends")
  expect(isTelemetryEligible()).toBe(false)
  const privateTimestamp = Date.now()
  const count = sent.length
  window.history.pushState(null, "", "/c/me/friends")
  onObservedRouteCommit()
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(2000)
  expect(sent).toHaveLength(count)

  for (const path of ["/demo", "/auth", "/c/invite/secret"]) {
    window.history.pushState(null, "", path)
    window.dispatchEvent(new PopStateEvent("popstate"))
    await vi.advanceTimersByTimeAsync(1500)
    expect(isTelemetryEligible()).toBe(false)
    expect(sent).toHaveLength(count)
  }

  onObservedRouterTransition("/pricing")
  window.history.pushState(null, "", "/pricing")
  onObservedRouteCommit()
  await vi.waitFor(() => expect(isTelemetryEligible()).toBe(true))
  native.faro!.api.pushEvent("faro.performance.resource", { name: window.location.origin + "/c/me/friends", duration: "777" }, undefined, { timestampOverwriteMs: privateTimestamp })
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(sent.flatMap(body => body.events ?? []).some(event => event.attributes?.duration === "777")).toBe(false)
  expect(sent.length).toBeGreaterThan(count)

  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  const deniedCount = sent.length
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(2000)
  expect(isTelemetryEligible()).toBe(false)
  expect(sent).toHaveLength(deniedCount)
})
