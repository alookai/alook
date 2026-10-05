import type { Span } from "@opentelemetry/api"
import { routeTemplate, actionNames } from "./coverage"
import { emitTelemetry, isTelemetryEligible, isNativeSessionContinuation, telemetryGeneration, notifyObservation } from "./telemetry"
import { cleanAttributes, type Attributes } from "./schema"

export type Action = { id: string; navigationId?: string; name: string; route: string; start: number; generation: number; done: boolean; span?: Span; timer?: ReturnType<typeof setTimeout> }
let makeSpan: ((name: string, attributes: Record<string, string>) => Span | undefined) | undefined
const live = new Set<Action>()
let navigation: Action | undefined
let navigationHref: string | undefined
let committedHref: string | undefined
let gesturePending = false
let sequence = 0
export function actionSequence() { return sequence }
const names = new Set<string>(actionNames)
export const telemetryId = () => typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now())
export const currentRoute = () => typeof window === "undefined" ? "/unmapped" : routeTemplate(window.location.href, window.location.origin)
export function installActionSpans(factory: typeof makeSpan) { makeSpan = factory }

export function startAction(name: string, attributes: Attributes = {}): Action | undefined {
  if (!isTelemetryEligible() || !names.has(name)) return
  if (live.size >= 64) finishAction(live.values().next().value, "cancelled")
  const action: Action = { id: telemetryId(), name, route: String(attributes.route_template ?? currentRoute()), start: performance.now(), generation: telemetryGeneration(), done: false }
  if (name === "navigation") action.navigationId = telemetryId()
  const fields = actionAttributes(action)
  try { action.span = makeSpan?.(name, cleanAttributes(fields)) } catch {}
  if (!isTelemetryEligible() || (action.generation !== telemetryGeneration() && !isNativeSessionContinuation(action.generation))) {
    try { action.span?.end() } catch {}
    return
  }
  action.generation = telemetryGeneration()
  sequence++
  live.add(action)
  emitTelemetry("action.start", { ...actionAttributes(action), ...attributes, phase: "intent" })
  action.timer = setTimeout(() => finishAction(action, "timeout"), 30_000)
  return action
}
export function actionAttributes(action?: Action): Attributes {
  let span
  try { span = action?.span?.spanContext() } catch {}
  return action ? { trace_id: span?.traceId, span_id: span?.spanId, action_id: action.id, navigation_id: action.navigationId, action_name: action.name, route_template: action.route, start_ms: action.start } : {}
}
export function finishAction(action: Action | undefined, outcome: Attributes["outcome"], fields: Attributes = {}) {
  if (!action || action.done) return
  action.done = true
  clearTimeout(action.timer)
  live.delete(action)
  if (action.generation === telemetryGeneration()) {
    emitTelemetry("action.finish", { ...actionAttributes(action), ...fields, outcome, duration_ms: performance.now() - action.start })
    const safeOutcome = cleanAttributes({ outcome }).outcome
    if (safeOutcome !== undefined) {
      try { action.span?.setAttribute("outcome", safeOutcome) } catch {}
    }
  }
  try { action.span?.end() } catch {}
  if (action === navigation) notifyObservation()
}
export function clearActions() {
  for (const action of live) finishAction(action, "cancelled")
  navigation = undefined
  navigationHref = undefined
  committedHref = undefined
  gesturePending = false
}
function normalizedHref(href: string) {
  const origin = typeof window === "undefined" ? "https://alook.ai" : window.location.origin
  try { const url = new URL(href, origin); return url.origin === origin ? url.pathname + url.search : undefined } catch { return undefined }
}
export function beginNavigation(href: string, phase: "intent" | "transport" | "gesture" = "intent") {
  if (!isTelemetryEligible()) return
  const target = normalizedHref(href)
  if (!target) return
  if (navigation && navigationHref === target && !navigation.done && (phase === "transport" || (phase === "intent" && gesturePending))) {
    gesturePending = false
    if (phase === "transport") emitTelemetry("navigation.intent", { ...actionAttributes(navigation), phase, request_reason: "router" })
    return navigation
  }
  finishAction(navigation, "superseded")
  navigation = startAction("navigation", { route_template: routeTemplate(href, typeof window === "undefined" ? "https://alook.ai" : window.location.origin) })
  if (!navigation) return
  navigationHref = target
  gesturePending = phase === "gesture"
  emitTelemetry("navigation.intent", { ...actionAttributes(navigation), phase: phase === "gesture" ? "intent" : phase, request_reason: "router" })
  notifyObservation()
  return navigation
}
export function navigationNoop(href: string) { const action = beginNavigation(href); finishAction(action, "noop") }
export function commitNavigation(href: string, region: "shell" | "page" = "shell") {
  if (!isTelemetryEligible()) return
  committedHref = normalizedHref(href)
  const matched = navigationHref === committedHref && navigation && !navigation.done ? navigation : undefined
  emitTelemetry("navigation.commit", { ...actionAttributes(matched), route_template: routeTemplate(href, typeof window === "undefined" ? "https://alook.ai" : window.location.origin), region, phase: "commit" })
  notifyObservation()
}
export function navigationForHref(href: string) {
  return navigation && !navigation.done && navigationHref === normalizedHref(href) ? navigation : undefined
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
