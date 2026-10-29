import { readBoundedJsonRequest as readBoundedHttpJsonRequest } from "@alook/shared"
import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_CONTRACT_HEADER,
  BUSINESS_SCHEMA_VERSION,
  type CommunityBrowserEventEnvelope,
  type CommunityContract,
  MESSAGE_DELIVERY_BODY_MAX_BYTES,
  MESSAGE_DELIVERY_MAX_EVENTS_PER_USER,
  COMMUNITY_USER_TARGET_PATH_PREFIX,
  decodeCommunityBrowserEvent,
  encodeCommunityBrowserEvent,
  isCommunityDeliveryDigest,
  isCommunityDeliveryOperationId,
  isValidCommunityUserTarget,
  prepareCommunityDeliveryEvents,
  type CommunityBrowserEventFailureReason,
  type CommunityDeliveryOperationId,
  type CommunityDeliveryDigest,
  type PreparedCommunityDeliveryEvents,
  type CommunityWsEvent,
} from "@alook/shared"

export type CommunityBrowserEventIngressFailure = {
  ok: false
  reason: CommunityBrowserEventFailureReason
  type: CommunityWsEvent["type"] | "unknown"
  byteCount?: number
}

type CommunityBrowserEventIngressSuccess = {
  ok: true
  event: CommunityWsEvent
  envelope: CommunityBrowserEventEnvelope
  body: string
  byteCount: number
  contract: CommunityContract
}

export type CommunityBrowserEventIngressResult =
  | CommunityBrowserEventIngressFailure
  | CommunityBrowserEventIngressSuccess

export type BoundedJsonResult =
  | { ok: true; value: unknown; byteCount: number }
  | CommunityBrowserEventIngressFailure

export async function readBoundedJsonRequest(request: Request, maxBytes: number): Promise<BoundedJsonResult> {
  const parsed = await readBoundedHttpJsonRequest(request, maxBytes)
  return parsed.ok ? parsed : { ...parsed, type: "unknown" }
}

export function normalizeCommunityBrowserEvent(
  value: unknown,
  byteCount?: number,
  contract: CommunityContract = BUSINESS_SCHEMA_VERSION,
): CommunityBrowserEventIngressResult {
  const decoded = decodeCommunityBrowserEvent(value, contract)
  if (!decoded.ok) return { ...decoded, ok: false, ...(byteCount === undefined ? {} : { byteCount }) }
  const encoded = encodeCommunityBrowserEvent(decoded.event, contract)
  if (!encoded.ok) {
    return {
      ok: false,
      reason: encoded.reason,
      type: encoded.type,
      byteCount: encoded.byteLength ?? byteCount,
    }
  }
  return {
    ok: true,
    event: decoded.event,
    envelope: encoded.envelope,
    body: encoded.body,
    byteCount: encoded.byteLength,
    contract,
  }
}

export async function readCommunityBrowserEventRequest(
  request: Request,
): Promise<CommunityBrowserEventIngressResult> {
  const parsed = await readBoundedJsonRequest(request, COMMUNITY_BROWSER_EVENT_MAX_BYTES)
  if (!parsed.ok) return parsed
  if (request.headers.get(COMMUNITY_CONTRACT_HEADER) !== String(BUSINESS_SCHEMA_VERSION)) return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  return normalizeCommunityBrowserEvent(parsed.value, parsed.byteCount, BUSINESS_SCHEMA_VERSION)
}

export async function readCommunityBrowserEventBundleRequest(
  request: Request,
): Promise<
  | {
      ok: true
      operationId: CommunityDeliveryOperationId
      operationDigest: CommunityDeliveryDigest
      prepared: PreparedCommunityDeliveryEvents
      eventCount: number
    }
  | CommunityBrowserEventIngressFailure
> {
  const parsed = await readBoundedJsonRequest(request, MESSAGE_DELIVERY_BODY_MAX_BYTES)
  if (!parsed.ok) return parsed
  if (request.headers.get(COMMUNITY_CONTRACT_HEADER) !== String(BUSINESS_SCHEMA_VERSION)) return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  if (
    typeof parsed.value !== "object"
    || parsed.value === null
    || Array.isArray(parsed.value)
    || Object.keys(parsed.value).length !== 4
    || !Object.prototype.hasOwnProperty.call(parsed.value, "operationId")
    || !Object.prototype.hasOwnProperty.call(parsed.value, "operationDigest")
    || !Object.prototype.hasOwnProperty.call(parsed.value, "events")
  ) {
    return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  }
  const input = parsed.value as {
    communityContract?: unknown
    operationId?: unknown
    operationDigest?: unknown
    events?: unknown
  }
  if (
    input.communityContract !== BUSINESS_SCHEMA_VERSION
    || !isCommunityDeliveryOperationId(input.operationId)
    || !isCommunityDeliveryDigest(input.operationDigest)
  ) {
    return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  }
  const events = input.events
  if (
    !Array.isArray(events)
    || events.length === 0
    || events.length > MESSAGE_DELIVERY_MAX_EVENTS_PER_USER
  ) {
    return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  }
  const decoded = events.map(event => decodeCommunityBrowserEvent(event))
  if (decoded.some(event => !event.ok)) return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  const prepared = await prepareCommunityDeliveryEvents(decoded.flatMap(result => result.ok ? [result.event] : []), BUSINESS_SCHEMA_VERSION)
  if (!prepared.ok || prepared.prepared.digest !== input.operationDigest) {
    return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  }
  return {
    ok: true,
    operationId: input.operationId,
    operationDigest: input.operationDigest,
    prepared: prepared.prepared,
    eventCount: events.length,
  }
}

export function decodeCommunityTargetPathSegment(encodedTarget: string):
  | { ok: true; target: string }
  | CommunityBrowserEventIngressFailure {
  if (!encodedTarget.startsWith(COMMUNITY_USER_TARGET_PATH_PREFIX)) {
    return { ok: false, reason: "invalid-target", type: "unknown" }
  }
  let target: string
  try {
    target = decodeURIComponent(encodedTarget.slice(COMMUNITY_USER_TARGET_PATH_PREFIX.length))
  } catch {
    return { ok: false, reason: "invalid-target", type: "unknown" }
  }
  if (!isValidCommunityUserTarget(target)) {
    return { ok: false, reason: "invalid-target", type: "unknown" }
  }
  return { ok: true, target }
}

export function invalidCommunityBrowserEventResponse(
  failure: CommunityBrowserEventIngressFailure,
): Response {
  return new Response(JSON.stringify({
    error: "Invalid community browser event",
    reason: failure.reason,
  }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  })
}

export function logCommunityBrowserEventRejected(
  log: { warn: (message: string, metadata: Record<string, unknown>) => void },
  route: "strict-single" | "strict-bulk" | "target-do" | "target-do-bundle" | "ws-do-producer",
  failure: CommunityBrowserEventIngressFailure,
  targetCount?: number,
) {
  log.warn("community_browser_event_rejected", {
    route,
    reason: failure.reason,
    type: failure.type,
    ...(failure.byteCount === undefined ? {} : { byteCount: failure.byteCount }),
    ...(targetCount === undefined ? {} : { targetCount }),
  })
}
