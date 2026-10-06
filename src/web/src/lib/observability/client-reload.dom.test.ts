import { afterEach, expect, it, vi } from "vitest"
import { initializeFaro, InternalLoggerLevel, SessionInstrumentation, VolatileSessionsManager } from "@grafana/faro-web-sdk"
import { act } from "@/test/react-dom-harness"
import { announceAnalyticsConsent } from "../analytics-consent"

afterEach(() => {
  document.cookie = "alook_analytics_consent=v1.denied; path=/"
  announceAnalyticsConsent("denied")
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
})
it("resumes the actual previous SDK document and preserves its initial session_resume through beforeSend", async () => {
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_FARO_COLLECTOR_URL", "https://collector.example/collect/public")
  vi.stubEnv("NEXT_PUBLIC_FARO_ENVIRONMENT", "qa")
  vi.stubEnv("NEXT_PUBLIC_FARO_RELEASE", "a".repeat(40))
  Object.defineProperty(performance, "getEntriesByType", { configurable: true, value: () => [] })
  document.cookie = "alook_analytics_consent=v1.granted; path=/"
  VolatileSessionsManager.removeUserSession()
  const priorDocument = initializeFaro({
    isolate: true, preventGlobalExposure: true, internalLoggerLevel: InternalLoggerLevel.OFF,
    app: { name: "alook-web" }, transports: [], instrumentations: [new SessionInstrumentation()],
    sessionTracking: { enabled: true, persistent: false, samplingRate: 1, session: { attributes: { alook_account: "anon" } } },
  })!
  const prior = VolatileSessionsManager.fetchUserSession()!
  expect(prior.sessionId).toBe(priorDocument.api.getSession()!.id)
  priorDocument.instrumentations.remove(...priorDocument.instrumentations.instrumentations)
  const sent: Array<{ meta: { sdk: { name: string; version: string }; session: { id: string } }; events?: Array<{ name: string; timestamp: string; attributes?: Record<string, string> }> }> = []
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: RequestInit) => { if (options?.body) sent.push(JSON.parse(String(options.body))); return new Response(null, { status: 204 }) }))
  const { bootstrapObservability } = await import("./client")
  const { emitTelemetry, isTelemetryEligible, telemetryGeneration } = await import("./telemetry")
  const { startAction, finishAction, actionAttributes } = await import("./context")
  let early!: ReturnType<typeof startAction>
  let initialGeneration = -1
  const earlyTimestamp = Date.now()
  await act(async () => {
    bootstrapObservability("web")
    initialGeneration = telemetryGeneration()
    early = startAction("message.edit")
    emitTelemetry("business.result", { ...actionAttributes(early), outcome: "success" })
    vi.setSystemTime(earlyTimestamp + 400)
  })
  expect(early).toBeDefined()
  await vi.waitFor(() => expect(sent.some(body => body.events?.some(event => event.name === "session_resume"))).toBe(true), { timeout: 5000 })
  expect(isTelemetryEligible()).toBe(true)
  expect(telemetryGeneration()).toBe(initialGeneration)
  expect(early!.done).toBe(false)
  finishAction(early, "success")
  emitTelemetry("business.result", { outcome: "success" })
  await vi.advanceTimersByTimeAsync(1500)
  const resumed = VolatileSessionsManager.fetchUserSession()!
  expect(resumed.sessionId).toBe(prior.sessionId)
  expect(resumed.started).toBe(prior.started)
  expect(sent.some(body => body.events?.some(event => event.name === "session_resume"))).toBe(true)
  expect(sent.some(body => body.events?.some(event => event.name === "business.result"))).toBe(true)
  const earlyExport = sent.flatMap(body => (body.events ?? []).filter(event => event.attributes?.action_id === early!.id).map(event => ({ event, meta: body.meta })))
  expect(earlyExport.map(record => record.event.name)).toEqual(["action.start", "business.result", "action.finish"])
  for (const { event, meta } of earlyExport) expect(event.attributes).toMatchObject({ action_id: early!.id, action_name: "message.edit", session_id: meta.session.id, start_ms: String(early!.start) })
  expect(Date.parse(earlyExport[0]!.event.timestamp)).toBe(earlyTimestamp)
  expect(Date.parse(earlyExport[1]!.event.timestamp)).toBe(earlyTimestamp)
  for (const body of sent) expect(body).toMatchObject({ meta: { sdk: { name: "faro-web", version: "2.12.1" }, session: { id: prior.sessionId } } })
  expect(JSON.stringify(sent)).not.toContain("alook_account")
})
