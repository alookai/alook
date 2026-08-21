import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
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
  type CommunityBrowserEventEnvelopeV1,
  type CommunityDeliveryOperationId,
  type CommunityDeliveryDigest,
  type PreparedCommunityDeliveryEvents,
  type CommunityWsEvent,
} from "@alook/shared"

export type CommunityBrowserEventIngressFailure = {
  ok: false
  reason: CommunityBrowserEventFailureReason
  type: CommunityWsEvent["type"] | "unknown"
  contractVersion?: number
  byteCount?: number
}

type CommunityBrowserEventIngressSuccess = {
  ok: true
  event: CommunityWsEvent
  envelope: CommunityBrowserEventEnvelopeV1
  body: string
  byteCount: number
  sourceVersion: 0 | 1
}

export type CommunityBrowserEventIngressResult =
  | CommunityBrowserEventIngressFailure
  | CommunityBrowserEventIngressSuccess

export type BoundedJsonResult =
  | { ok: true; value: unknown; byteCount: number }
  | CommunityBrowserEventIngressFailure

function oversized(byteCount: number): CommunityBrowserEventIngressFailure {
  return { ok: false, reason: "oversized", type: "unknown", byteCount }
}

export async function readBoundedJsonRequest(
  request: Request,
  maxBytes: number,
): Promise<BoundedJsonResult> {
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null) {
    const declared = Number(contentLength)
    if (Number.isSafeInteger(declared) && declared > maxBytes) return oversized(declared)
  }
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, reason: "invalid-json", type: "unknown", byteCount: 0 }
  const chunks: Uint8Array[] = []
  let byteCount = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteCount += value.byteLength
      if (byteCount > maxBytes) {
        try {
          await reader.cancel()
        } catch {}
        return oversized(byteCount)
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: "invalid-json", type: "unknown", byteCount }
  }
  const bytes = new Uint8Array(byteCount)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return { ok: false, reason: "invalid-json", type: "unknown", byteCount }
  }
  try {
    return { ok: true, value: JSON.parse(text), byteCount }
  } catch {
    return { ok: false, reason: "invalid-json", type: "unknown", byteCount }
  }
}

export function normalizeCommunityBrowserEvent(
  value: unknown,
  byteCount?: number,
): CommunityBrowserEventIngressResult {
  const decoded = decodeCommunityBrowserEvent(value)
  if (!decoded.ok) return { ...decoded, ok: false, ...(byteCount === undefined ? {} : { byteCount }) }
  const encoded = encodeCommunityBrowserEvent(decoded.event)
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
    envelope: encoded.event,
    body: encoded.body,
    byteCount: encoded.byteLength,
    sourceVersion: decoded.sourceVersion,
  }
}

export async function readCommunityBrowserEventRequest(
  request: Request,
): Promise<CommunityBrowserEventIngressResult> {
  const parsed = await readBoundedJsonRequest(request, COMMUNITY_BROWSER_EVENT_MAX_BYTES)
  if (!parsed.ok) return parsed
  return normalizeCommunityBrowserEvent(parsed.value, parsed.byteCount)
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
  if (
    typeof parsed.value !== "object"
    || parsed.value === null
    || Array.isArray(parsed.value)
    || Object.keys(parsed.value).length !== 3
    || !Object.prototype.hasOwnProperty.call(parsed.value, "operationId")
    || !Object.prototype.hasOwnProperty.call(parsed.value, "operationDigest")
    || !Object.prototype.hasOwnProperty.call(parsed.value, "events")
  ) {
    return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  }
  const input = parsed.value as {
    operationId?: unknown
    operationDigest?: unknown
    events?: unknown
  }
  if (
    !isCommunityDeliveryOperationId(input.operationId)
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
  const prepared = await prepareCommunityDeliveryEvents(events)
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
    ...(failure.contractVersion === undefined ? {} : { contractVersion: failure.contractVersion }),
    ...(failure.byteCount === undefined ? {} : { byteCount: failure.byteCount }),
    ...(targetCount === undefined ? {} : { targetCount }),
  })
}
