import "fake-indexeddb/auto"
import { useLayoutEffect } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { act, render, waitFor } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

const backend = vi.hoisted(() => { const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); return fetch })
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
vi.mock("@/lib/perf/react-scan-install", () => ({ installReactScan: vi.fn(async () => {}) }))
let mounted: ReturnType<typeof render> | undefined
afterEach(async () => {
  await act(async () => { mounted?.unmount(); mounted = undefined; document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); await new Promise(resolve => setTimeout(resolve, 0)) })
  window.history.replaceState(null, "", "/")
  vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
it("real auth and Application sign-out preserve failure/B ownership and clear only the current successful user's native metadata", async () => {
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  window.history.replaceState(null, "", "/workspaces")
  let selected: string | null = "account-a"
  let mode: "fail" | "hold" | "success" = "fail"
  let release!: (response: Response) => void
  const now = new Date().toISOString()
  const user = (id: string) => ({ id, name: "Private", email: "private@example.test", emailVerified: true, createdAt: now, updatedAt: now, image: null })
  const session = () => selected ? { user: user(selected), session: { id: "auth-" + selected, token: "fixture", userId: selected, expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: now, updatedAt: now } } : null
  const sent: Array<{ meta: { session: { id: string }; user?: { id: string } }; events?: Array<{ name: string }> }> = []
  backend.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    if (url.hostname === "collector.example") { sent.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }) }
    if (url.pathname.endsWith("/get-session")) return Response.json(session())
    if (url.pathname.endsWith("/sign-in/email")) { selected = "account-b"; return Response.json({ redirect: false, user: user(selected), token: "fixture" }) }
    if (url.pathname.endsWith("/sign-out")) {
      if (mode === "fail") return Response.json({ message: "Auth failed" }, { status: 400 })
      if (mode === "hold") return new Promise<Response>(resolve => { release = resolve })
      selected = null; return Response.json({ success: true })
    }
    throw new Error("Unexpected auth fixture path " + url.pathname)
  })
  const auth = await import("../auth-client")
  const Application = await import("../application-owner")
  const { useApplicationSignOut } = await import("@/hooks/use-application-sign-out")
  const { VolatileSessionsManager } = await import("@grafana/faro-web-sdk")
  const { emitTelemetry, isTelemetryEligible } = await import("./telemetry")
  let logout!: () => Promise<boolean>
  let owner!: ReturnType<typeof Application.useApplicationOwner>
  function Probe() {
    const current = Application.useApplicationOwner(), command = useApplicationSignOut()
    useLayoutEffect(() => { owner = current; logout = () => command.mutateAsync() }, [current, command])
    return <p>Account content</p>
  }
  function Root({ id }: { id: string }) { return <Application.ApplicationQueryProvider userId={id}><Probe /></Application.ApplicationQueryProvider> }
  await act(async () => { await import("@/instrumentation-client"); mounted = render(<Root id="account-a" />) })
  await waitFor(() => expect(auth.currentSessionViewer()).toBe("account-a"))
  await waitFor(() => expect(isTelemetryEligible()).toBe(true))
  await waitFor(() => expect(sent.some(body => body.meta.user?.id === "account-a")).toBe(true), { timeout: 5000 })
  const aSession = VolatileSessionsManager.fetchUserSession()!.sessionId
  await act(async () => { await expect(logout()).rejects.toThrow("Auth failed") })
  expect(owner.lifecycle.get().active).toBe(true)
  expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(aSession)
  mode = "hold"
  let oldResult!: Promise<unknown>
  act(() => { oldResult = logout().catch(error => error) })
  await waitFor(() => expect(release).toBeTypeOf("function"))
  await act(async () => { const result = await auth.authClient.signIn.email({ email: "b@example.test", password: "fixture-password" }); expect(result.error).toBeNull() })
  await waitFor(() => expect(auth.currentSessionViewer()).toBe("account-b"))
  await act(async () => mounted!.rerender(<Root id="account-b" />))
  await waitFor(() => expect(owner.userId).toBe("account-b"))
  await waitFor(() => expect(isTelemetryEligible()).toBe(true))
  await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(aSession))
  const bSession = VolatileSessionsManager.fetchUserSession()!.sessionId
  await act(async () => { release(Response.json({ success: true })); expect(await oldResult).toMatchObject({ name: "AbortError" }) })
  expect(owner.lifecycle.get().active).toBe(true)
  expect(VolatileSessionsManager.fetchUserSession()!.sessionId).toBe(bSession)
  emitTelemetry("business.result", { outcome: "success" })
  await waitFor(() => expect(sent.some(body => body.meta.session.id === bSession && body.meta.user?.id === "account-b")).toBe(true), { timeout: 5000 })
  mode = "success"
  await act(async () => { await logout() })
  await waitFor(() => expect(auth.currentSessionViewer()).toBeNull())
  await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(bSession))
  const anonymous = VolatileSessionsManager.fetchUserSession()!.sessionId
  await act(async () => window.history.replaceState(null, "", "/sign-in"))
  emitTelemetry("business.result", { outcome: "success" })
  await waitFor(() => expect(sent.some(body => body.meta.session.id === anonymous)).toBe(true), { timeout: 5000 })
  for (const body of sent.filter(body => body.meta.session.id === anonymous)) expect(body.meta.user).toBeUndefined()
  await act(async () => { await auth.authClient.signIn.email({ email: "b@example.test", password: "fixture-password" }) })
  await waitFor(() => expect(auth.currentSessionViewer()).toBe("account-b"))
  await act(async () => mounted!.rerender(<Root key="reentry" id="account-b" />))
  await waitFor(() => expect(isTelemetryEligible()).toBe(true))
  await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(anonymous))
  const confirmedAccount = VolatileSessionsManager.fetchUserSession()!.sessionId
  await act(async () => { const result = await auth.authClient.signOut(); expect(result.error).toBeNull() })
  await waitFor(() => expect(auth.currentSessionViewer()).toBeNull())
  await waitFor(() => expect(VolatileSessionsManager.fetchUserSession()!.sessionId).not.toBe(confirmedAccount))
  const confirmedAnonymous = VolatileSessionsManager.fetchUserSession()!.sessionId
  emitTelemetry("business.result", { outcome: "success" })
  await waitFor(() => expect(sent.some(body => body.meta.session.id === confirmedAnonymous)).toBe(true), { timeout: 5000 })
  for (const body of sent.filter(body => body.meta.session.id === confirmedAnonymous)) expect(body.meta.user).toBeUndefined()
  expect(JSON.stringify(sent)).not.toContain("private@example.test")
})
