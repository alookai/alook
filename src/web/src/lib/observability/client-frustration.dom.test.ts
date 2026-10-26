import { afterEach, expect, it, vi } from "vitest"
import type { Faro } from "@grafana/faro-web-sdk"
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

let control: HTMLButtonElement | undefined
afterEach(async () => {
  control?.remove()
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  await vi.advanceTimersByTimeAsync(0)
  native.faro?.instrumentations.remove(...native.faro.instrumentations.instrumentations)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("keeps real default frustration events outside the outgoing allowlist across consent revocation", async () => {
  vi.useFakeTimers(); sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const sent: unknown[] = []
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal("fetch", fetch)
  const consent = (value: "granted" | "denied") => {
    document.cookie = "alook_analytics_consent=v1." + value + "; path=/"
    announceAnalyticsConsent(value)
  }
  consent("denied")
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  bootstrapObservability("blog")
  expect(native.faro).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => { consent("granted") })
  await vi.waitFor(() => expect(native.faro).toBeDefined())
  expect(isTelemetryEligible()).toBe(true)
  expect(native.faro!.instrumentations.instrumentations.map(item => item.name)).toContain("@grafana/faro-web-sdk:instrumentation-frustration")
  const pushed = vi.spyOn(native.faro!.api, "pushEvent")
  control = document.createElement("button")
  control.textContent = "PRIVATE_CONTROL"
  control.setAttribute("data-faro-user-action-name", "PRIVATE_ACTION")
  document.body.append(control)
  emitTelemetry("business.result", { outcome: "success" })
  control.click(); control.click(); control.click()
  await vi.advanceTimersByTimeAsync(1500)
  expect(pushed).toHaveBeenCalledWith("faro.frustration.rage_click", expect.objectContaining({ clickCount: "3" }), undefined, expect.objectContaining({ skipDedupe: true }))
  expect(JSON.stringify(sent)).toContain("business.result")
  expect(JSON.stringify(sent)).not.toMatch(/faro\.frustration|PRIVATE_CONTROL|PRIVATE_ACTION/)
  const beforeRevocation = sent.length
  consent("denied")
  expect(isTelemetryEligible()).toBe(false)
  control.click(); control.click(); control.click()
  await vi.advanceTimersByTimeAsync(3000)
  expect(sent).toHaveLength(beforeRevocation)
})
