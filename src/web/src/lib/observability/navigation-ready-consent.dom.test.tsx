import { afterEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"
import { useObservedRegion } from "./regions"

vi.mock("next/navigation", () => ({ usePathname: () => window.location.pathname, useSearchParams: () => new URLSearchParams() }))
let view: ReturnType<typeof render> | undefined
afterEach(async () => {
  await act(async () => { view?.unmount(); document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await Promise.resolve() })
  window.history.replaceState(null, "", "/")
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})

it("does not backfill a pre-consent document visit and observes only later eligible navigation", async () => {
  sessionStorage.clear()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([])
  const sent: Array<{ events?: Array<{ name: string; attributes: Record<string, string> }> }> = []
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.body) sent.push(JSON.parse(String(options.body)))
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal("fetch", fetch)
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  const { bootstrapObservability, onObservedRouterTransition } = await import("./client")
  function Content() { useObservedRegion("page", true, { source: "unknown", version: "static", freshness: "unknown", count: 1 }); return <p>Ready page</p> }
  await act(async () => { bootstrapObservability("web"); view = render(<Content />) })
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => { document.cookie = "alook_analytics_consent=v1.granted; path=/"; announceAnalyticsConsent("granted") })
  const events = () => sent.flatMap(body => body.events ?? [])
  await waitFor(() => expect(events().some(event => event.name === "region.ready_commit")).toBe(true), { timeout: 5000 })
  expect(events().some(event => event.name === "navigation.ready")).toBe(false)
  await act(async () => { onObservedRouterTransition("/pricing"); window.history.pushState(null, "", "/pricing"); view!.rerender(<Content />) })
  await waitFor(() => expect(events().filter(event => event.name === "navigation.ready")).toHaveLength(1), { timeout: 5000 })
  const ready = events().filter(event => event.name === "navigation.ready")
  expect(ready).toHaveLength(1)
  expect(ready[0]?.attributes).toMatchObject({ navigation_kind: "route", route_template: "/pricing", region: "page" })
})
