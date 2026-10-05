import type { Faro, Instrumentation, FetchTransport } from "@grafana/faro-web-sdk"
import type { getDefaultOTELInstrumentations } from "@grafana/faro-web-tracing"
import { ANALYTICS_CONSENT_CHANGE_EVENT, hasAnalyticsConsent } from "../analytics-consent"
import { capabilityLimits, routeTemplate } from "./coverage"
import { actionSequence, beginNavigation, clearActions, finishAction, installActionSpans, startAction, telemetryId } from "./context"
import { configureTelemetry, emitTelemetry, installTelemetrySink, isTelemetryEligible, telemetryGeneration, reportTelemetryDrops, retireTelemetry } from "./telemetry"
import { sanitizeItem } from "./sanitize"
import { installBrowserObservers } from "./browser"

type BuildProfile = { url?: string; environment?: string; release?: string }
function validBuildProfile(profile: BuildProfile) {
  try {
    const url = new URL(profile.url ?? "")
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && ["production", "qa"].includes(profile.environment ?? "") && /^[0-9a-f]{40}$/.test(profile.release ?? "")
  } catch { return false }
}
const build: BuildProfile = {
  url: process.env.NEXT_PUBLIC_FARO_COLLECTOR_URL,
  environment: process.env.NEXT_PUBLIC_FARO_ENVIRONMENT,
  release: process.env.NEXT_PUBLIC_FARO_RELEASE,
}
let started = false
let faro: Faro | undefined
let transport: FetchTransport | undefined
let controller: AbortController | undefined
let sessionId = ""
let load: Promise<void> | undefined
let pendingReconcile = false
let deliveryFailures = 0
let deliveryFailureReason = "unknown"
let makeTransport: (() => FetchTransport) | undefined
let stopBrowser: (() => void) | undefined
let eligibleSince = 0
let vitalsInitialized = false
let surface: "web" | "blog" = "web"
let userKey: string | undefined
let httpInstrumentations: ReturnType<typeof getDefaultOTELInstrumentations> = []
let webInstrumentations: Instrumentation[] = []
const pageId = telemetryId()

function deactivate() {
  retireTelemetry()
  clearActions()
  installActionSpans(undefined)
  stopBrowser?.()
  stopBrowser = undefined
  faro?.pause()
  if (transport) faro?.transports.remove(transport)
  controller?.abort()
  transport = undefined
  controller = undefined
  deliveryFailures = 0
  deliveryFailureReason = "unknown"
  for (const instrumentation of httpInstrumentations.flat()) instrumentation.disable()
}
function configure() {
  configureTelemetry({ release: build.release, environment: build.environment, frontend_surface: surface, page_instance_id: pageId, session_id: sessionId, user_key: userKey }, true)
}
async function activate() {
  if (!hasAnalyticsConsent() || !validBuildProfile(build)) return
  sessionId = telemetryId()
  configure()
  const capturedSession = sessionId
  const [{ initializeFaro, FetchTransport: NativeFetchTransport, getWebInstrumentations, InternalLoggerLevel }, { TracingInstrumentation, getDefaultOTELInstrumentations: createHttp }] = await Promise.all([
    import("@grafana/faro-web-sdk"), import("@grafana/faro-web-tracing"),
  ])
  if (!hasAnalyticsConsent() || capturedSession !== sessionId || !isTelemetryEligible()) return
  makeTransport = () => {
    controller = new AbortController()
    const ownerSession = sessionId
    class ObservedFetchTransport extends NativeFetchTransport {
      override logError(...args: Parameters<FetchTransport["logError"]>) {
        if (ownerSession !== sessionId || !isTelemetryEligible()) return
        deliveryFailures = Math.min(deliveryFailures + 1, 1_000_000)
        const detail = args.find(value => value && typeof value === "object") as Record<string, unknown> | undefined
        deliveryFailureReason = detail?.status === 429 ? "rate_limit" : detail?.kind === "http" || typeof detail?.status === "number" ? "http_error" : detail?.kind === "timeout" ? "timeout" : detail?.kind === "aborted" ? "abort" : String(args[0]).includes("retries exhausted") ? "retries_exhausted" : "unknown"
      }
    }
    return new ObservedFetchTransport({ url: build.url!, bufferSize: 16, concurrency: 2, retry: { maxAttempts: 2, initialBackoffMs: 1000, maxBackoffMs: 5000 }, requestTimeoutMs: 5000, requestOptions: { signal: controller.signal, credentials: "omit" } })
  }
  transport = makeTransport()
  if (!faro) {
    httpInstrumentations = createHttp({ ignoreUrls: [build.url!], propagateTraceHeaderCorsUrls: [new RegExp("^" + window.location.origin.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "/")] })
    const defaults = getWebInstrumentations({ captureConsole: false, enableContentSecurityPolicyInstrumentation: false, enablePerformanceInstrumentation: false })
    const vitals = defaults.find(instrumentation => instrumentation.name.endsWith("instrumentation-web-vitals"))
    if (vitals) {
      const initialize = vitals.initialize
      vitals.initialize = function () {
        if (vitalsInitialized) return
        vitalsInitialized = true
        const original = this.api.pushMeasurement
        this.api = { ...this.api, pushMeasurement: (measurement, options) => {
          if (!hasAnalyticsConsent() || !isTelemetryEligible()) return
          const values = Object.fromEntries(Object.entries(measurement.values).filter(([key,value]) => /^(lcp|cls|inp|fcp|ttfb)$/.test(key) && typeof value === "number" && Number.isFinite(value)))
          if (Object.keys(values).length) original({ type: "web-vitals", values }, { skipDedupe: options?.skipDedupe })
        } }
        initialize.call(this)
      }
    }
    webInstrumentations = defaults.filter(instrumentation => !instrumentation.name.endsWith("instrumentation-errors") && !instrumentation.name.endsWith("instrumentation-navigation"))
    faro = initializeFaro({
      app: { name: "alook-web", version: build.release, release: build.release, environment: build.environment },
      preventGlobalExposure: true,
      dedupe: false,
      internalLoggerLevel: InternalLoggerLevel.OFF,
      transports: [transport],
      instrumentations: [...webInstrumentations, new TracingInstrumentation({ instrumentations: httpInstrumentations })],
      sessionTracking: { enabled: true, persistent: false, samplingRate: 1, generateSessionId: telemetryId, onSessionChange: (_previous, next) => { if (next.id) adoptNativeSession(next.id) } },
      pageTracking: { generatePageId: () => pageId },
      trackGeolocation: false,
      webVitalsInstrumentation: { trackAttributionSources: false },
      batching: { enabled: true, itemLimit: 40, sendTimeout: 1000 },
      beforeSend: item => hasAnalyticsConsent() && isTelemetryEligible() ? sanitizeItem(item, sessionId, window.location.origin) : null,
    })
  } else {
    faro.transports.add(transport)
    for (const instrumentation of httpInstrumentations.flat()) instrumentation.enable()
    faro.unpause()
  }
  if (!faro) { deactivate(); return }
  faro.api.setUser(userKey ? { id: userKey } : undefined)
  faro.api.setSession({ id: capturedSession, attributes: { isSampled: "true" } })
  installActionSpans((name, attributes) => {
    if (!isTelemetryEligible()) return
    return faro?.api.getOTEL()?.trace.getTracer("alook.frontend").startSpan(name, { attributes })
  })
  connectSink()
  stopBrowser = installBrowserObservers(faro, build.url!, eligibleSince)
  beginNavigation(window.location.href)
  emitTelemetry("telemetry.coverage", { collection_rate: 1, eligibility: "eligible", capability: "available", count: Object.keys(capabilityLimits).length })
}
function connectSink() {
  installTelemetrySink(event => {
    if (!hasAnalyticsConsent() || !isTelemetryEligible()) return
    if (deliveryFailures) {
      const count = deliveryFailures
      deliveryFailures = 0
      faro?.api.pushEvent("telemetry.coverage", { delivery_failure_count: String(count), delivery_failure_reason: deliveryFailureReason, outcome: "error", capability: "limited", session_id: sessionId, frontend_surface: surface }, "alook.frontend", { skipDedupe: true })
    }
    faro?.api.pushEvent(event.name, event.attributes, "alook.frontend", { skipDedupe: true, timestampOverwriteMs: event.timestamp })
  })
}
function adoptNativeSession(next: string) {
  if (next === sessionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(next) || !hasAnalyticsConsent() || !isTelemetryEligible()) return
  retireTelemetry("native_session")
  clearActions()
  stopBrowser?.()
  if (transport) faro?.transports.remove(transport)
  controller?.abort()
  sessionId = next
  deliveryFailures = 0
  deliveryFailureReason = "unknown"
  eligibleSince = performance.now()
  configure()
  transport = makeTransport?.()
  if (transport) faro?.transports.add(transport)
  connectSink()
  if (faro) stopBrowser = installBrowserObservers(faro, build.url!, eligibleSince)
  emitTelemetry("telemetry.coverage", { eligibility: "eligible", capability: "available", phase: "auth" })
}
function reconcile() {
  if (!hasAnalyticsConsent()) { deactivate(); return }
  if (load) { pendingReconcile = true; return }
  if (isTelemetryEligible()) return
  load = activate().catch(() => { deactivate() }).finally(() => {
    load = undefined
    if (pendingReconcile) { pendingReconcile = false; reconcile() }
  })
}
export function setTelemetryUser(key: string | null) {
  const next = key && /^[a-zA-Z0-9_-]{8,64}$/.test(key) ? key : undefined
  if (userKey === next) return
  const wasEligible = isTelemetryEligible()
  deactivate()
  userKey = next
  sessionId = telemetryId()
  if (wasEligible || hasAnalyticsConsent()) reconcile()
}
export function bootstrapObservability(nextSurface: "web" | "blog") {
  if (started || typeof window === "undefined") return
  started = true
  surface = nextSurface
  window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, () => { eligibleSince = performance.now(); reconcile() })
  window.addEventListener("popstate", () => { if (isTelemetryEligible()) beginNavigation(window.location.href) })
  document.addEventListener("visibilitychange", () => {
    if (isTelemetryEligible()) { reportTelemetryDrops("transport_failure"); emitTelemetry("telemetry.coverage", { visibility: document.visibilityState, capability: "limited" }) }
  })
  window.addEventListener("pagehide", () => { if (isTelemetryEligible()) emitTelemetry("telemetry.coverage", { drop_reason: "unload_unknown", capability: "limited" }) })
  document.addEventListener("click", event => {
    if (!isTelemetryEligible() || !(event.target instanceof Element)) return
    const control = event.target.closest("a,button,[role=button],input[type=checkbox],select")
    if (!control) return
    if (control instanceof HTMLAnchorElement && control.href && control.origin === window.location.origin && !control.download && control.target !== "_blank" && !(event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) && routeTemplate(control.href, window.location.origin) !== "/unmapped") beginNavigation(control.href, "gesture")
    else {
      const before = actionSequence(), generation = telemetryGeneration()
      queueMicrotask(() => {
        if (!isTelemetryEligible() || generation !== telemetryGeneration() || actionSequence() !== before) return
        const action = startAction("ui_interaction", { phase: "interaction" })
        if (!faro?.api.getActiveUserAction()) faro?.api.startUserAction("ui_interaction", { session_id: sessionId })
        finishAction(action, "observed", { phase: "interaction" })
      })
    }
  }, { capture: true, passive: true })
  reconcile()
}
export function onObservedRouterTransition(url: string) {
  if (isTelemetryEligible()) beginNavigation(url, "transport")
}
