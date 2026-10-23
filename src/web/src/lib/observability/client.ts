import type { Faro, FetchTransport } from "@grafana/faro-web-sdk"
import type { getDefaultOTELInstrumentations } from "@grafana/faro-web-tracing"
import { isMobile, isTauri } from "@alook/shared"
import { ANALYTICS_CONSENT_CHANGE_EVENT, isPublicAnalyticsPath, readAnalyticsConsent } from "../analytics-consent"
import { capabilityLimits, routeTemplate } from "./coverage"
import { ROOT_CONTEXT } from "@opentelemetry/api"
import { actionSequence, beginNavigation, clearActions, installActionSpans, telemetryId, currentPageObservation, actionAttributes, startPageOperation, finishPageOperation } from "./context"
import { alignInitialTelemetrySession, configureTelemetry, emitTelemetry, installTelemetrySink, isTelemetryEligible, telemetryGeneration, reportTelemetryDrops, retireTelemetry } from "./telemetry"
import { cleanAttributes } from "./schema"
import { sanitizeItem } from "./sanitize"
import { installLongTaskObserver } from "./browser"
import { resolveCommunityModulePlan } from "../community/community-route"
import { observeTransportSpan, finishTransportSpan, installNavigationFetchContext } from "./requests"
import { resolveFrontendIdentity } from "./runtime"
import { resolveObservationLabels } from "./build"
import { finishTransportClock } from "./clock"
import { observeResourceResponse } from "./resource"

function hasObservationConsent(href = typeof window === "undefined" ? undefined : window.location.href) {
  const decision = readAnalyticsConsent()
  if (decision !== null) return decision === "granted"
  if (isTauri() || typeof window === "undefined" || !href) return false
  const url = new URL(href, window.location.origin)
  return url.origin === window.location.origin && isPublicAnalyticsPath(url.pathname)
}

type BuildProfile = { url?: string; environment?: string; release?: string; release_status: string; environment_status: string }
function validBuildProfile(profile: BuildProfile) {
  try {
    const url = new URL(profile.url ?? "")
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
const build: BuildProfile = {
  url: process.env.NEXT_PUBLIC_FARO_COLLECTOR_URL,
  ...resolveObservationLabels({ environment: process.env.NEXT_PUBLIC_FARO_ENVIRONMENT, release: process.env.NEXT_PUBLIC_FARO_RELEASE }),
}
let started = false
let documentSuspended = false
let faro: Faro | undefined
let transport: FetchTransport | undefined
let controller: AbortController | undefined
let sessionId = ""
let load: Promise<void> | undefined
let pendingReconcile = false
let pendingInitialNavigation = false
let makeTransport: (() => FetchTransport) | undefined
let stopNavigationFetch: (() => void) | undefined
let stopBrowser: (() => void) | undefined
let documentVitalsEligible = hasObservationConsent()
let eligibleSince = 0
let eligibleTimestamp = Date.now() - (typeof performance === "undefined" ? 0 : performance.now())
let identity = resolveFrontendIdentity("web", false, false, process.env.NEXT_PUBLIC_APP_VERSION)
let userKey: string | undefined
let identityEstablished = false
let identityRevision = 0
let mayResumeNativeSession = hasObservationConsent()
let clearNativeSession: (() => void) | undefined
let httpInstrumentations: ReturnType<typeof getDefaultOTELInstrumentations> = []
const pageId = telemetryId()

function deactivate() {
  stopNavigationFetch?.()
  stopNavigationFetch = undefined
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
  for (const instrumentation of httpInstrumentations.flat()) instrumentation.disable()
}
function configure() {
  configureTelemetry({ release: build.release, environment: build.environment, release_status: build.release_status, environment_status: build.environment_status, ...identity, page_instance_id: pageId, session_id: sessionId, user_key: userKey }, true)
}
async function activate() {
  if (documentSuspended || !hasObservationConsent() || !validBuildProfile(build)) return
  const route = routeTemplate(window.location.href, window.location.origin)
  const communityOwner = (route === "/c" || route.startsWith("/c/")) && resolveCommunityModulePlan(window.location.pathname).route !== "public-invite"
  if (!identityEstablished && communityOwner) return
  const mayResume = mayResumeNativeSession
  sessionId = telemetryId()
  configure()
  if (pendingInitialNavigation) { pendingInitialNavigation = false; beginNavigation(window.location.href, "document") }
  const capturedSession = sessionId
  const [{ initializeFaro, FetchTransport: NativeFetchTransport, getWebInstrumentations, InternalLoggerLevel, VolatileSessionsManager }, { getDefaultOTELInstrumentations: createHttp }, { ObservationTracingInstrumentation }] = await Promise.all([
    import("@grafana/faro-web-sdk"), import("@grafana/faro-web-tracing"), import("./clock-tracing"),
  ])
  clearNativeSession = () => VolatileSessionsManager.removeUserSession()
  if (documentSuspended || !hasObservationConsent() || capturedSession !== sessionId || !isTelemetryEligible()) return
  mayResumeNativeSession = false
  makeTransport = () => {
    controller = new AbortController()
    return new NativeFetchTransport({ url: build.url!, bufferSize: 16, concurrency: 2, retry: { maxAttempts: 2, initialBackoffMs: 1000, maxBackoffMs: 5000 }, requestTimeoutMs: 5000, requestOptions: { signal: controller.signal, credentials: "omit" } })
  }
  transport = makeTransport()
  if (!faro) {
    const accountScope = userKey ?? "anon"
    let storedScope: string | undefined
    try { storedScope = VolatileSessionsManager.fetchUserSession()?.sessionMeta?.attributes?.alook_account } catch { clearNativeSession() }
    if (!mayResume || storedScope !== accountScope) clearNativeSession()
    httpInstrumentations = createHttp({ fetchInstrumentationOptions: { ignoreNetworkEvents: false, requestHook: observeTransportSpan, applyCustomAttributesOnSpan: (span, _request, result) => finishTransportSpan(span, result) }, xhrInstrumentationOptions: { ignoreNetworkEvents: false, applyCustomAttributesOnSpan: (span, xhr) => { finishTransportClock(span); observeResourceResponse(span, xhr.getResponseHeader("server-timing") ?? "") } }, ignoreUrls: [build.url!], propagateTraceHeaderCorsUrls: [new RegExp("^" + window.location.origin.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "/")] })
    const defaults = getWebInstrumentations({ captureConsole: false, enableContentSecurityPolicyInstrumentation: false, enablePerformanceInstrumentation: true })
    const initialTransport = transport
    faro = initializeFaro({
      app: { name: "alook-web", version: identity.app_version, release: build.release, environment: build.environment },
      preventGlobalExposure: true,
      dedupe: false,
      internalLoggerLevel: InternalLoggerLevel.OFF,
      transports: [transport],
      instrumentations: [...defaults, new ObservationTracingInstrumentation({ instrumentations: httpInstrumentations })],
      sessionTracking: { enabled: true, persistent: false, samplingRate: 1, generateSessionId: telemetryId, session: { attributes: { alook_account: accountScope } }, onSessionChange: (_previous, next) => { if (next.id) adoptNativeSession(next.id) } },
      pageTracking: { generatePageId: () => pageId },
      trackGeolocation: false,
      trackResources: true,
      ignoreUrls: [build.url!],
      webVitalsInstrumentation: { trackAttributionSources: false },
      batching: { enabled: true, itemLimit: 40, sendTimeout: 1000 },
      beforeSend: item => hasObservationConsent() && isTelemetryEligible() ? sanitizeItem(item, sessionId, window.location.origin, identity, eligibleTimestamp, documentVitalsEligible, eligibleTimestamp, eligibleSince) : null,
    })
    const initialized = faro?.api.getSession()
    if (!faro || !initialized?.id || !/^[a-zA-Z0-9_-]{1,80}$/.test(initialized.id) || initialized.attributes?.alook_account !== accountScope) { deactivate(); return }
    if (initialized.id !== capturedSession) {
      if (!alignInitialTelemetrySession(capturedSession, initialized.id)) { deactivate(); return }
      sessionId = initialized.id
      configure()
      faro.transports.remove(initialTransport)
      controller?.abort()
      transport = makeTransport()
      faro.transports.add(transport)
    }
    faro.api.setUser(userKey ? { id: userKey } : undefined)
  } else {
    faro.transports.add(transport)
    for (const instrumentation of httpInstrumentations.flat()) instrumentation.enable()
    faro.api.setUser(userKey ? { id: userKey } : undefined)
    faro.unpause()
    faro.api.setSession({ id: capturedSession, attributes: { isSampled: "true", alook_account: userKey ?? "anon" } })
  }
  if (!faro) { deactivate(); return }
  installActionSpans((name, attributes, startTime, links, parent) => {
    if (!isTelemetryEligible()) return
    const otel = faro?.api.getOTEL()
    return otel?.trace.getTracer("alook.frontend").startSpan(name, { attributes, startTime, links }, parent ? otel.trace.setSpan(otel.context.active(), parent) : ROOT_CONTEXT)
  })
  connectSink()
  stopNavigationFetch = installNavigationFetchContext()
  stopBrowser = installLongTaskObserver(eligibleSince)
  if (!documentVitalsEligible) emitTelemetry("telemetry.coverage", { capability: "limited", request_kind: "document", phase: "background" })
  emitTelemetry("telemetry.coverage", { collection_rate: 1, eligibility: "eligible", capability: "available", count: Object.keys(capabilityLimits).length })
}
function connectSink() {
  installTelemetrySink(event => {
    if (!hasObservationConsent() || !isTelemetryEligible()) return
    faro?.api.pushEvent(event.name, event.attributes, "alook.frontend", { skipDedupe: true, timestampOverwriteMs: event.timestamp })
  })
}
function adoptNativeSession(next: string) {
  if (next === sessionId || !/^[a-zA-Z0-9_-]{1,80}$/.test(next) || !hasObservationConsent() || !isTelemetryEligible()) return
  retireTelemetry("native_session")
  clearActions()
  stopBrowser?.()
  if (transport) faro?.transports.remove(transport)
  controller?.abort()
  sessionId = next
  eligibleSince = performance.now()
  eligibleTimestamp = Date.now()
  configure()
  transport = makeTransport?.()
  if (transport) faro?.transports.add(transport)
  connectSink()
  if (faro) stopBrowser = installLongTaskObserver(eligibleSince)
  emitTelemetry("telemetry.coverage", { eligibility: "eligible", capability: "available", phase: "auth" })
}
function reconcile() {
  if (documentSuspended) return
  if (!hasObservationConsent()) { documentVitalsEligible = false; mayResumeNativeSession = false; clearNativeSession?.(); deactivate(); return }
  if (load) { pendingReconcile = true; return }
  if (isTelemetryEligible()) return
  load = activate().catch(() => { deactivate() }).finally(() => {
    load = undefined
    if (pendingReconcile) { pendingReconcile = false; reconcile() }
  })
}
export function setTelemetryUser(key: string | null) {
  const next = key && /^[a-zA-Z0-9_-]{8,64}$/.test(key) ? key : undefined
  const firstIdentity = !identityEstablished
  identityEstablished = true
  if (userKey === next) { if (firstIdentity && started) reconcile(); return }
  identityRevision++
  if (!firstIdentity || faro) { mayResumeNativeSession = false; clearNativeSession?.() }
  const wasEligible = isTelemetryEligible()
  deactivate()
  if (!firstIdentity) { eligibleSince = performance.now(); eligibleTimestamp = Date.now() }
  userKey = next
  sessionId = telemetryId()
  if (wasEligible || hasObservationConsent()) reconcile()
}
export function captureTelemetryIdentityRetirement() {
  const original = userKey, revision = identityRevision
  return () => { if (original && original === userKey && revision === identityRevision) setTelemetryUser(null) }
}
export function bootstrapObservability(nextSurface: "web" | "blog") {
  if (started || typeof window === "undefined") return
  started = true
  identity = resolveFrontendIdentity(nextSurface, isTauri(), isMobile(), process.env.NEXT_PUBLIC_APP_VERSION)
  pendingInitialNavigation = hasObservationConsent() && validBuildProfile(build)
  window.addEventListener(ANALYTICS_CONSENT_CHANGE_EVENT, () => { eligibleSince = performance.now(); eligibleTimestamp = Date.now(); if (!hasObservationConsent()) pendingInitialNavigation = false; reconcile() })
  window.addEventListener("popstate", () => { onObservedRouteCommit(); if (isTelemetryEligible()) beginNavigation(window.location.href) })
  document.addEventListener("visibilitychange", () => {
    if (isTelemetryEligible()) { reportTelemetryDrops("transport_failure"); emitTelemetry("telemetry.coverage", { visibility: document.visibilityState, capability: "limited" }) }
  })
  window.addEventListener("pagehide", () => {
    documentSuspended = true
    documentVitalsEligible = false
    pendingInitialNavigation = false
    deactivate()
  }, { capture: true })
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return
    documentSuspended = false
    pendingInitialNavigation = false
    mayResumeNativeSession = false
    clearNativeSession?.()
    eligibleSince = performance.now()
    eligibleTimestamp = Date.now()
    deactivate()
    reconcile()
  }, { capture: true })
  document.addEventListener("click", event => {
    if (!isTelemetryEligible() || !(event.target instanceof Element)) return
    const control = event.target.closest("a,button,[role=button],input[type=checkbox],select")
    if (!control) return
    if (control instanceof HTMLAnchorElement && !hasObservationConsent(control.href)) return
    if (control instanceof HTMLAnchorElement && control.href && control.origin === window.location.origin && !control.download && control.target !== "_blank" && !(event instanceof MouseEvent && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) && routeTemplate(control.href, window.location.origin) !== "/unmapped") beginNavigation(control.href, "gesture")
    else {
      const before = actionSequence(), generation = telemetryGeneration(), owner = currentPageObservation(), interactionStart = performance.now()
      queueMicrotask(() => {
        if (!isTelemetryEligible() || generation !== telemetryGeneration() || actionSequence() !== before) return
        const operation = startPageOperation("ui.interaction", { phase: "interaction" }, owner, interactionStart)
        finishPageOperation(operation, "observed")
        try { if (!faro?.api.getActiveUserAction()) faro?.api.startUserAction("ui_interaction", cleanAttributes({ ...actionAttributes(owner), session_id: sessionId })) } catch {}
      })
    }
  }, { capture: true, passive: true })
  reconcile()
}
export function onObservedRouteCommit() {
  if (!started) return
  if (!isTelemetryEligible()) { eligibleSince = performance.now(); eligibleTimestamp = Date.now() }
  reconcile()
}
export function onObservedRouterTransition(url: string) {
  if (!hasObservationConsent(url)) {
    documentVitalsEligible = false
    pendingInitialNavigation = false
    mayResumeNativeSession = false
    clearNativeSession?.()
    deactivate()
    return
  }
  if (isTelemetryEligible()) beginNavigation(url, "transport")
}
