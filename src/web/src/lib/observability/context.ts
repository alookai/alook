import { isSpanContextValid, type Span, type HrTime, type Link, context, trace } from "@opentelemetry/api"
import { recordDocumentTiming } from "./document-timing"
import { observationTime, observationOrigin, observationOwnerGeneration, retireObservationSpan } from "./clock"
import { routeTemplate, actionNames } from "./coverage"
import { emitTelemetry, isTelemetryEligible, isNativeSessionContinuation, telemetryGeneration, notifyObservation, linkQueuedActionTrace } from "./telemetry"
import { cleanAttributes, type Attributes } from "./schema"

export type Action = { id: string; navigationId?: string; navigationKind?: "document" | "route"; name: string; route: string; start: number; origin: number; generation: number; done: boolean; end?: number; outcome?: Attributes["outcome"]; span?: Span; timer?: ReturnType<typeof setTimeout>; prefetch?: Action; parent?: Action; pageId?: string }
let makeSpan: ((name: string, attributes: Record<string, string>, startTime: HrTime, links: Link[], parent?: Span) => Span | undefined) | undefined
const live = new Set<Action>()
const deferred = new Set<Action | PageOperation>()
let prefetch: Action | undefined
let prefetchHref: string | undefined
let navigation: Action | undefined
let navigationHref: string | undefined
let page: Action | undefined
let pageHref: string | undefined
let committedHref: string | undefined
let gesturePending = false
let sequence = 0
export function actionSequence() { return sequence }
const names = new Set<string>(actionNames)
export const telemetryId = () => typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now())
export const currentRoute = () => typeof window === "undefined" ? "/unmapped" : routeTemplate(window.location.href, window.location.origin)
export function installActionSpans(factory: typeof makeSpan) {
  makeSpan = factory
  if (!factory) return
  for (const action of deferred) {
    deferred.delete(action)
    if (!isTelemetryEligible() || action.generation !== telemetryGeneration()) continue
    if ("page" in action) {
      action.span = pageOperationSpan(action)
      if (action.done) endPageOperationSpan(action)
      continue
    }
    let span: Span | undefined
    try { span = action.parent && !action.parent.span ? undefined : factory(action.name, cleanAttributes(actionAttributes(action)), observationTime(action.start, action.origin), actionLinks(action), action.parent?.span) } catch {}
    if (!isTelemetryEligible() || action.generation !== telemetryGeneration()) { retireObservationSpan(span); try { span?.end() } catch {}; continue }
    action.span = span
    if (span) action.parent = undefined
    const attributes = actionAttributes(action)
    linkQueuedActionTrace(action.id, action.generation, attributes.trace_id, attributes.span_id)
    if (action.done && action.end !== undefined) {
      const outcome = cleanAttributes({ outcome: action.outcome }).outcome
      if (outcome !== undefined) { try { span?.setAttribute("outcome", outcome) } catch {} }
      if (action.navigationKind === "document") { try { recordDocumentTiming(span, action.origin, action.end) } catch {} }
      try { span?.end(observationTime(action.end, action.origin)) } catch {}
    }
  }
}

export function startAction(name: string, attributes: Attributes = {}, start = performance.now(), sourcePrefetch?: Action): Action | undefined {
  if (!isTelemetryEligible() || !names.has(name)) return
  if (live.size >= 64) finishAction(live.values().next().value, "cancelled")
  const parent = name === "navigation" ? undefined : currentPageObservation()
  const action: Action = { id: telemetryId(), name, route: String(attributes.route_template ?? currentRoute()), start, origin: parent?.origin ?? observationOrigin(), generation: telemetryGeneration(), done: false, prefetch: sourcePrefetch, parent, pageId: parent?.navigationId }
  if (name === "navigation") { action.navigationId = telemetryId(); action.navigationKind = attributes.navigation_kind === "document" ? "document" : "route" }
  const fields = actionAttributes(action)
  try { action.span = parent && !parent.span ? undefined : makeSpan?.(name, cleanAttributes(fields), observationTime(action.start, action.origin), actionLinks(action), parent?.span)
    if (action.span) action.parent = undefined } catch {}
  if (!isTelemetryEligible() || (action.generation !== telemetryGeneration() && !isNativeSessionContinuation(action.generation)) || (parent && parent.generation !== telemetryGeneration())) {
    retireObservationSpan(action.span)
    try { action.span?.end() } catch {}
    return
  }
  action.generation = telemetryGeneration()
  sequence++
  live.add(action)
  if (!action.span) {
    if (deferred.size >= 64) deferred.delete(deferred.values().next().value!)
    deferred.add(action)
  }
  emitTelemetry("action.start", { ...actionAttributes(action), ...attributes, phase: "intent" })
  action.timer = setTimeout(() => finishAction(action, "timeout"), 30_000)
  return action
}
function actionLinks(action: Action): Link[] {
  const source = action.prefetch
  if (!source || source.generation !== action.generation) return []
  try { const context = source.span?.spanContext(); return context && isSpanContextValid(context) ? [{ context, attributes: { relationship: "prefetch" } }] : [] } catch { return [] }
}
export function actionAttributes(action?: Action): Attributes {
  let span
  try { span = action?.span?.spanContext() } catch {}
  return action ? { trace_id: span?.traceId, span_id: span?.spanId, action_id: action.id, navigation_id: action.navigationId, page_id: action.pageId ?? action.navigationId, navigation_kind: action.navigationKind, prefetch_action_id: action.prefetch?.id, action_name: action.name, route_template: action.route, start_ms: action.start, observation_origin_ms: action.origin, clock_source: "operation_monotonic", clock_domain: "browser", clock_alignment: "unverified" } : {}
}
export function finishAction(action: Action | undefined, outcome: Attributes["outcome"], fields: Attributes = {}) {
  if (!action || action.done) return
  action.done = true
  action.end = performance.now()
  action.outcome = outcome
  clearTimeout(action.timer)
  live.delete(action)
  if (action.generation === telemetryGeneration()) {
    const attributes = { ...actionAttributes(action), ...fields, outcome, duration_ms: action.end - action.start, clock_skew_ms: Math.abs(observationOrigin() - action.origin) }
    emitTelemetry("action.finish", attributes)
    if (action.navigationId && outcome === "success" && fields.phase === "primary") {
      if (action === navigation) { page = action; pageHref = navigationHref }
      emitTelemetry("navigation.ready", attributes)
    }
    const safeOutcome = cleanAttributes({ outcome }).outcome
    if (safeOutcome !== undefined) {
      try { action.span?.setAttribute("outcome", safeOutcome) } catch {}
    }
    try { action.span?.setAttribute("clock_skew_ms", Math.abs(observationOrigin() - action.origin)) } catch {}
  }
  if (action.navigationKind === "document") { try { recordDocumentTiming(action.span, action.origin, action.end) } catch {} }
  try { action.span?.end(observationTime(action.end, action.origin)) } catch {}
  if (action === navigation) notifyObservation()
}
export function startRegionObservation(action: Action | undefined, region: Attributes["region"], evidence?: Attributes) {
  if (!action || action.done) return
  return startPageOperation("region.wait", { region, phase: "commit", source: "unknown", ...evidence }, action)
}
export function finishRegionObservation(operation: PageOperation | undefined, action: Action | undefined, outcome: Attributes["outcome"]) {
  if (!action || operation?.page !== action) return
  finishPageOperation(operation, outcome)
}
export function clearActions() {
  for (const action of live) finishAction(action, "cancelled")
  deferred.clear()
  prefetch = undefined
  prefetchHref = undefined
  navigation = undefined
  navigationHref = undefined
  gesturePending = false
  page = undefined
  pageHref = undefined
}
function normalizedHref(href: string) {
  const origin = typeof window === "undefined" ? "https://alook.ai" : window.location.origin
  try { const url = new URL(href, origin); return url.origin === origin ? url.pathname + url.search : undefined } catch { return undefined }
}
export function beginNavigationPrefetch(href: string) {
  const target = normalizedHref(href)
  if (!target || !isTelemetryEligible()) return
  if (prefetchHref === target && prefetch?.generation === telemetryGeneration() && !prefetch.done) return prefetch
  finishAction(prefetch, "superseded")
  prefetch = startAction("navigation.prefetch", { route_template: routeTemplate(href, typeof window === "undefined" ? "https://alook.ai" : window.location.origin) })
  prefetchHref = target
  return prefetch
}
export function prefetchForHref(href: string) {
  return prefetch?.generation === telemetryGeneration() && prefetchHref === normalizedHref(href) ? prefetch : undefined
}
export function beginNavigation(href: string, phase: "intent" | "transport" | "gesture" | "document" = "intent") {
  if (!isTelemetryEligible()) return
  const target = normalizedHref(href)
  if (!target) return
  if (navigation && navigationHref === target && !navigation.done && (phase === "transport" || (phase === "intent" && gesturePending))) {
    gesturePending = false
    if (phase === "transport") emitTelemetry("navigation.intent", { ...actionAttributes(navigation), phase, request_reason: "router" })
    return navigation
  }
  finishAction(navigation, "superseded")
  navigation = startAction("navigation", { route_template: routeTemplate(href, typeof window === "undefined" ? "https://alook.ai" : window.location.origin), navigation_kind: phase === "document" ? "document" : "route" }, phase === "document" ? 0 : performance.now(), prefetchForHref(href))
  if (navigation?.prefetch) finishAction(navigation.prefetch, "observed")
  if (!navigation) return
  navigationHref = target
  if (phase === "document") { page = navigation; pageHref = target }
  gesturePending = phase === "gesture"
  emitTelemetry("navigation.intent", { ...actionAttributes(navigation), phase: phase === "document" ? "hydrate" : phase === "gesture" ? "intent" : phase, request_reason: "router" })
  notifyObservation()
  return navigation
}
export function navigationNoop(href: string) { const action = beginNavigation(href); finishAction(action, "noop") }
export function commitNavigation(href: string, region: "shell" | "page" = "shell") {
  const previous = committedHref
  committedHref = normalizedHref(href)
  if (!isTelemetryEligible()) return
  const matched = navigationHref === committedHref && navigation?.generation === telemetryGeneration() ? navigation : undefined
  if (matched) { page = matched; pageHref = committedHref }
  else if (committedHref !== previous) { page = undefined; pageHref = undefined }
  emitTelemetry("navigation.commit", { ...actionAttributes(matched), route_template: routeTemplate(href, typeof window === "undefined" ? "https://alook.ai" : window.location.origin), region, phase: "commit" })
  notifyObservation()
}
export function committedNavigationPathname() { return committedHref?.split("?")[0] }
export function navigationForHref(href: string) {
  return navigation && !navigation.done && navigationHref === normalizedHref(href) ? navigation : undefined
}
export function currentPageObservation() {
  if (!isTelemetryEligible() || typeof window === "undefined") return
  return page?.generation === telemetryGeneration() && pageHref === normalizedHref(window.location.href) ? page : undefined
}
export type PageOperation = { page: Action; start: number; generation: number; name: "ws.connect" | "ws.event_applied" | "cache.restore" | "ui.interaction" | "region.wait"; fields: Attributes; span?: Span; done: boolean; end?: number; outcome?: Attributes["outcome"] }
function pageOperationSpan(operation: PageOperation) {
  if (!isTelemetryEligible() || operation.generation !== telemetryGeneration() || !operation.page.span) return
  try {
    const span = makeSpan?.(operation.name, cleanAttributes({ ...actionAttributes(operation.page), ...operation.fields, span_role: operation.name === "region.wait" ? "region_readiness" : "page_operation" }), observationTime(operation.start, operation.page.origin), [], operation.page.span)
    if (!isTelemetryEligible() || operation.generation !== telemetryGeneration()) { retireObservationSpan(span); try { span?.end() } catch {}; return }
    const id = span?.spanContext()
    if (id) { span?.setAttribute("trace_id", id.traceId); span?.setAttribute("span_id", id.spanId) }
    return span
  } catch { return undefined }
}
export function startPageOperation(name: PageOperation["name"], fields: Attributes, owner: Action | undefined, start = performance.now()): PageOperation | undefined {
  if (!owner || !isTelemetryEligible() || owner.generation !== telemetryGeneration()) return
  const operation: PageOperation = { page: owner, start, generation: owner.generation, name, fields, done: false }
  operation.span = pageOperationSpan(operation)
  if (!operation.span) {
    if (deferred.size >= 64) deferred.delete(deferred.values().next().value!)
    deferred.add(operation)
  }
  return operation
}
export function pageOperationAttributes(operation?: PageOperation): Attributes {
  if (!operation || operation.generation !== telemetryGeneration()) return {}
  const native = operation.span?.spanContext()
  return { ...actionAttributes(operation.page), ...operation.fields, trace_id: native?.traceId ?? operation.page.span?.spanContext().traceId, span_id: native?.spanId ?? operation.page.span?.spanContext().spanId, start_ms: operation.start, duration_ms: performance.now() - operation.start }
}
export function runPageOperation<T>(operation: PageOperation | undefined, execute: () => T): T {
  const span = operation?.generation === telemetryGeneration() ? operation.span ?? operation.page.span : undefined
  return span && isTelemetryEligible() ? context.with(trace.setSpan(context.active().setValue(observationOwnerGeneration, operation!.generation), span), execute) : execute()
}
export function finishPageOperation(operation: PageOperation | undefined, outcome: Attributes["outcome"]) {
  if (!operation || operation.done) return
  operation.done = true
  operation.end = performance.now()
  operation.outcome = outcome
  operation.span ??= pageOperationSpan(operation)
  endPageOperationSpan(operation)
}
function endPageOperationSpan(operation: PageOperation) {
  if (!isTelemetryEligible() || operation.generation !== telemetryGeneration()) retireObservationSpan(operation.span)
  try { operation.span?.setAttribute("outcome", String(operation.outcome)) } catch {}
  try { operation.span?.end(observationTime(operation.end!, operation.page.origin)) } catch {}
}
const commandActions = new WeakMap<object, Action>()
export function bindCommandAction(value: unknown, action: Action, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return
  commandActions.set(value, action)
  const object = value as Record<string, unknown>
  for (const key of ["original", "token", "intent"]) bindCommandAction(object[key], action, depth + 1)
}
export function commandObservation(value: unknown): { action?: Action; reason: "command" } | undefined {
  const action = value && typeof value === "object" ? commandActions.get(value) : undefined
  return action && action.generation === telemetryGeneration() ? { action, reason: "command" } : undefined
}
