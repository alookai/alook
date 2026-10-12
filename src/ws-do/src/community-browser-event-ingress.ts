import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_CONTRACT_HEADER,
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
  envelope: CommunityWsEvent
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
  contract: CommunityContract = 2,
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
    envelope: encoded.event,
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
  const version = request.headers.get(COMMUNITY_CONTRACT_HEADER)
  if (version !== null && version !== "1" && version !== "2" && version !== "3") return { ok: false, reason: "invalid-payload", type: "unknown", byteCount: parsed.byteCount }
  return normalizeCommunityBrowserEvent(parsed.value, parsed.byteCount, version === "3" ? 3 : version === "1" ? 1 : 2)
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
    || Object.keys(parsed.value).length !== ("communityContract" in parsed.value && parsed.value.communityContract === 3 ? 4 : 3)
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
    (Object.hasOwn(input, "communityContract") && input.communityContract !== 3)
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
  const prepared = await prepareCommunityDeliveryEvents(events, input.communityContract === 3 ? 3 : 2)
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
