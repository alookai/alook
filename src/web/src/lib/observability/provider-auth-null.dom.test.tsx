import "fake-indexeddb/auto"
import { createContext, useContext, useLayoutEffect } from "react"
import { useIsRestoring } from "@tanstack/react-query"
import { afterEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

type Identity = { data: { user: { id: string } } | null; isPending: boolean; error: Error | null }
const identityInput = createContext<Identity>({ data: null, isPending: true, error: null })
let viewer: string | null | undefined
vi.mock("@/lib/auth-client", () => ({ useSession: () => useContext(identityInput), currentSessionViewer: () => viewer }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let old: ReturnType<typeof render> | undefined, current: ReturnType<typeof render> | undefined
afterEach(async () => {
  await act(async () => { old?.unmount(); current?.unmount(); old = current = undefined; document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await new Promise(resolve => setTimeout(resolve, 0)) })
  window.history.replaceState(null, "", "/")
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
it("public and community Providers retain pending/error and newer B, then retire telemetry on current confirmed SDK anonymous identity", async () => {
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/pricing")
  const sent: Array<{ meta: { session: { id: string }; user?: { id: string } } }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => { if (init?.body) sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }))
  const { bootstrapObservability } = await import("./client")
  const { QueryProvider } = await import("@/app/c/QueryProvider")
  const { PublicQueryProvider } = await import("../application-owner")
  const { VolatileSessionsManager } = await import("@grafana/faro-web-sdk")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  bootstrapObservability("web")
  const known = (id: string): Identity => ({ data: { user: { id } }, isPending: false, error: null })
  const restoring = new Map<string, boolean>()
  function Probe({ id }: { id: string }) { const pending = useIsRestoring(); useLayoutEffect(() => { restoring.set(id, pending) }, [id, pending]); return <p>{id}</p> }
  function PublicProvider({ children }: { userId: string; children: React.ReactNode }) { return <PublicQueryProvider>{children}</PublicQueryProvider> }
  for (const kind of ["public", "community"] as const) {
    const Provider = kind === "public" ? PublicProvider : QueryProvider
    function Root({ id, identity }: { id: string; identity: Identity }) { return <identityInput.Provider value={identity}><Provider userId={id}><Probe id={id} /></Provider></identityInput.Provider> }
    const a = kind + "-a", b = kind + "-b"
    viewer = a
    await act(async () => { old = render(<Root id={a} identity={known(a)} />) })
    await waitFor(() => expect(restoring.get(a)).toBe(false))
    await waitFor(() => expect(isTelemetryEligible()).toBe(true))
    await waitFor(() => expect(sent.some(body => body.meta.user?.id === a)).toBe(true), { timeout: 5000 })
    const originalSession = VolatileSessionsManager.fetchUserSession()!.sessionId
    viewer = undefined
    await act(async () => old!.rerender(<Root id={a} identity={{ data: null, isPending: true, error: null }} />))
    expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(originalSession)
    await act(async () => old!.rerender(<Root id={a} identity={{ data: null, isPending: false, error: new Error("Auth pending") }} />))
    expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(originalSession)
    viewer = b
    await act(async () => { current = render(<Root id={b} identity={known(b)} />) })
    await waitFor(() => expect(restoring.get(b)).toBe(false))
    await waitFor(() => expect(isTelemetryEligible()).toBe(true))
    await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(originalSession))
    const replacementSession = VolatileSessionsManager.fetchUserSession()!.sessionId
    await act(async () => old!.rerender(<Root id={a} identity={{ data: null, isPending: false, error: null }} />))
    expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(replacementSession)
    emitTelemetry("business.result", { outcome: "success" })
    await waitFor(() => expect(sent.some(body => body.meta.session.id === replacementSession && body.meta.user?.id === b)).toBe(true), { timeout: 5000 })
    await act(async () => { old!.unmount(); old = undefined })
    viewer = null
    await act(async () => current!.rerender(<Root id={b} identity={{ data: null, isPending: false, error: null }} />))
    await waitFor(() => expect(isTelemetryEligible()).toBe(true))
    await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(replacementSession))
    const anonymousSession = VolatileSessionsManager.fetchUserSession()!.sessionId
    emitTelemetry("business.result", { outcome: "success" })
    await waitFor(() => expect(sent.some(body => body.meta.session.id === anonymousSession)).toBe(true), { timeout: 5000 })
    for (const body of sent.filter(body => body.meta.session.id === anonymousSession)) expect(body.meta.user).toBeUndefined()
    await act(async () => { current!.unmount(); current = undefined; await new Promise(resolve => setTimeout(resolve, 0)) })
  }
})
