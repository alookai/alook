import { afterEach, expect, it, vi } from "vitest"
import { act } from "@/test/react-dom-harness"
import type { Faro } from "@grafana/faro-web-sdk"
import { announceAnalyticsConsent } from "../analytics-consent"

const native = vi.hoisted(() => ({ faro: undefined as Faro | undefined, release: undefined as (() => void) | undefined }))
vi.mock("@grafana/faro-web-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@grafana/faro-web-sdk")>()
  await new Promise<void>(resolve => { native.release = resolve })
  return { ...real, initializeFaro: (...args: Parameters<typeof real.initializeFaro>) => { native.faro = real.initializeFaro(...args); return native.faro } }
})
afterEach(() => { document.cookie = "alook_analytics_consent=v1.denied; path=/"; announceAnalyticsConsent("denied"); vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
it("real Faro sessions align after interrupted import, regrant, account changes, expiry and reload metadata", async () => {
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  sessionStorage.setItem("com.grafana.faro.session", JSON.stringify({ sessionId: "previous-document", lastActivity: Date.now(), started: Date.now(), isSampled: true, sessionMeta: { id: "previous-document", attributes: { isSampled: "true" } } }))
  const sent: unknown[] = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }) }))
  const { bootstrapObservability, setTelemetryUser } = await import("./client")
  const { emitTelemetry, telemetryGeneration, isTelemetryEligible } = await import("./telemetry")
  const { beginNavigation, navigationForHref, finishAction, startAction } = await import("./context")
  const consent = (value: "granted" | "denied") => { document.cookie = "alook_analytics_consent=v1." + value + "; path=/"; announceAnalyticsConsent(value) }
  await act(async () => { consent("granted"); bootstrapObservability("web") })
  await vi.waitFor(() => expect(native.release).toBeTypeOf("function"))
  expect(native.release).toBeTypeOf("function")
  consent("denied"); setTelemetryUser("account-b"); consent("granted")
  native.release?.()
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  expect(isTelemetryEligible()).toBe(true)
  const session = native.faro!.api.getSession()!.id
  expect(session).not.toBe("previous-document")
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(JSON.stringify(sent)).toContain(session)
  expect(JSON.stringify(sent)).toContain("business.result")
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.some(body => (body as { events?: Array<{ name: string }> }).events?.some(event => event.name === "session_start"))).toBe(true)
  for (const body of sent) expect(body).toMatchObject({ meta: { sdk: { name: "faro-web", version: "2.12.1" } } })
  const generation = telemetryGeneration()
  emitTelemetry("business.result", { action_name: "message.edit", outcome: "success" })
  const beforeAccount = sent.length
  setTelemetryUser("account-c")
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  expect(native.faro!.api.getSession()!.id).not.toBe(session)
  expect(telemetryGeneration()).toBeGreaterThan(generation)
  emitTelemetry("business.result", { action_name: "message.pin", outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(JSON.stringify(sent.slice(beforeAccount))).not.toContain("message.edit")
  expect(JSON.stringify(sent.slice(beforeAccount))).toContain("message.pin")
  const accountSession = native.faro!.api.getSession()!.id
  vi.setSystemTime(Date.now() + 5 * 60 * 60 * 1000)
  const beforeExpiry = sent.length
  const first = beginNavigation("/c/me/bots")!
  expect(first.done).toBe(false)
  expect(first.span?.isRecording()).toBe(true)
  expect(first.generation).toBe(telemetryGeneration())
  expect(navigationForHref("/c/me/bots")).toBe(first)
  finishAction(first, "success")
  expect(first.span?.isRecording()).toBe(false)
  await vi.advanceTimersByTimeAsync(1500)
  const extended = native.faro!.api.getSession()!.id
  expect(extended).not.toBe(accountSession)
  const expiryPayload = JSON.stringify(sent.slice(beforeExpiry))
  expect(expiryPayload).toContain(first.id)
  expect(expiryPayload).toContain("action.start")
  expect(expiryPayload).toContain("action.finish")
  expect(expiryPayload).toContain(extended)
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(JSON.stringify(sent)).toContain(extended)
  const spans: Record<string, unknown>[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    if (typeof record.spanId === "string") spans.push(record)
    for (const child of Object.values(record)) visit(child)
  }
  visit(sent.slice(beforeExpiry))
  expect(spans.some(span => span.name === "navigation" && JSON.stringify(span).includes(first.id) && JSON.stringify(span).includes(extended))).toBe(true)
  const { apiFetchResponse } = await import("@/lib/api/client")
  const beforeRequests = sent.length
  const one = startAction("message.edit")!, two = startAction("message.pin")!
  const firstContext = one.span!.spanContext(), secondContext = two.span!.spanContext()
  await Promise.all([
    apiFetchResponse("/api/agents", { observation: { action: one, reason: "command" } }),
    apiFetchResponse("/api/workspaces", { observation: { action: two, reason: "command" } }),
  ])
  finishAction(one, "success"); finishAction(two, "success")
  await vi.advanceTimersByTimeAsync(3000)
  spans.length = 0
  visit(sent.slice(beforeRequests))
  const children = (parent: typeof firstContext) => spans.filter(span => span.traceId === parent.traceId && span.parentSpanId === parent.spanId)
  expect(children(firstContext)).toHaveLength(1)
  expect(children(secondContext)).toHaveLength(1)
  expect(children(firstContext)[0]?.name).toBe("GET /api/agents")
  expect(children(secondContext)[0]?.name).toBe("GET /api/workspaces")
  for (const body of sent) expect(body).toMatchObject({ meta: { sdk: { name: "faro-web", version: "2.12.1" } } })
  consent("denied")
  const size = sent.length
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  expect(sent).toHaveLength(size)
})
