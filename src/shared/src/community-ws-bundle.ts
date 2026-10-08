import {
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  decodeCommunityBrowserEvent,
  encodeCommunityBrowserEvent,
  utf8ByteLength,
  type CommunityWsEvent,
} from "./community-ws-events"
import { MESSAGE_DELIVERY_MAX_EVENTS_PER_USER } from "./community-message-delivery"
import { COMMUNITY_CONTRACT_VERSION, type CommunityContract } from "./community-contract"

export const COMMUNITY_BROWSER_EVENT_BATCH_TYPE = "community:events.batch" as const

export function communityBrowserEventBatchType(contract: number = COMMUNITY_CONTRACT_VERSION) {
  if (contract === 1) return COMMUNITY_BROWSER_EVENT_BATCH_TYPE
  if (contract === COMMUNITY_CONTRACT_VERSION) return `${COMMUNITY_BROWSER_EVENT_BATCH_TYPE}.v${COMMUNITY_CONTRACT_VERSION}` as const
  throw new Error("unsupported community event contract")
}
export const COMMUNITY_DELIVERY_OPERATION_ID_PREFIX = "message:" as const
export const COMMUNITY_DELIVERY_OPERATION_ID_HEADER = "x-alook-community-operation-id" as const
export const COMMUNITY_DELIVERY_OPERATION_ID_BYTES = 51
export const COMMUNITY_DELIVERY_DIGEST_HEX_LENGTH = 64
export const COMMUNITY_BROWSER_EVENT_BATCH_ENVELOPE_BYTES = 1_024
export const COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES =
  MESSAGE_DELIVERY_MAX_EVENTS_PER_USER * COMMUNITY_BROWSER_EVENT_MAX_BYTES
  + COMMUNITY_BROWSER_EVENT_BATCH_ENVELOPE_BYTES

const OPERATION_ID_RE = /^message:[A-Za-z0-9_-]{43}$/
const DIGEST_RE = /^[0-9a-f]{64}$/

export type CommunityDeliveryOperationId = `${typeof COMMUNITY_DELIVERY_OPERATION_ID_PREFIX}${string}`
export type CommunityDeliveryDigest = string

export type CommunityBrowserEventBatch = {
  type: ReturnType<typeof communityBrowserEventBatchType>
  wireDigest?: CommunityDeliveryDigest
  operationId: CommunityDeliveryOperationId
  operationDigest: CommunityDeliveryDigest
  events: CommunityWsEvent[]
}

export type PreparedCommunityDeliveryEvents = {
  events: CommunityWsEvent[]
  envelopes: CommunityWsEvent[]
  bodies: string[]
  digest: CommunityDeliveryDigest
}

export type CommunityDeliveryPrepareFailureReason =
  | "invalid-event-count"
  | "invalid-child"
  | "oversized-child"

export type CommunityDeliveryPrepareResult =
  | { ok: true; prepared: PreparedCommunityDeliveryEvents }
  | {
      ok: false
      reason: CommunityDeliveryPrepareFailureReason
      eventIndex?: number
      byteLength?: number
    }

export type CommunityBrowserEventBatchEncodeResult =
  | {
      ok: true
      batch: CommunityBrowserEventBatch
      body: string
      byteLength: number
      childBodies: string[]
    }
  | {
      ok: false
      reason:
        | CommunityDeliveryPrepareFailureReason
        | "invalid-operation-id"
        | "invalid-operation-digest"
        | "digest-mismatch"
        | "batch-invariant-oversized"
      eventIndex?: number
      byteLength?: number
      actualDigest?: CommunityDeliveryDigest
    }

export type CommunityBrowserEventBatchDecodeResult =
  | { ok: true; batch: CommunityBrowserEventBatch; events: CommunityWsEvent[] }
  | {
      ok: false
      reason:
        | "oversized"
        | "non-object"
        | "missing-type"
        | "wrong-type"
        | "invalid-operation-id"
        | "invalid-operation-digest"
        | "invalid-payload"
        | "invalid-event-count"
        | "invalid-child"
      eventIndex?: number
      byteLength?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false
    }
  }
  return true
}

function bytesToHex(bytes: Uint8Array): string {
  let value = ""
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0")
  return value
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  let value = ""
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const combined = (first << 16) | (second << 8) | third
    value += alphabet[(combined >>> 18) & 63]
    value += alphabet[(combined >>> 12) & 63]
    if (index + 1 < bytes.length) value += alphabet[(combined >>> 6) & 63]
    if (index + 2 < bytes.length) value += alphabet[combined & 63]
  }
  return value
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(value.byteLength)
  input.set(value)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer))
}

export function isCommunityDeliveryOperationId(value: unknown): value is CommunityDeliveryOperationId {
  return typeof value === "string"
    && utf8ByteLength(value) === COMMUNITY_DELIVERY_OPERATION_ID_BYTES
    && OPERATION_ID_RE.test(value)
}

export function isCommunityDeliveryDigest(value: unknown): value is CommunityDeliveryDigest {
  return typeof value === "string"
    && value.length === COMMUNITY_DELIVERY_DIGEST_HEX_LENGTH
    && DIGEST_RE.test(value)
}

export async function deriveCommunityDeliveryOperationId(
  messageId: string,
): Promise<CommunityDeliveryOperationId> {
  if (messageId.length === 0 || !isWellFormedUnicode(messageId)) {
    throw new Error("invalid community delivery message id")
  }
  const digest = await sha256(new TextEncoder().encode(messageId))
  const operationId = `${COMMUNITY_DELIVERY_OPERATION_ID_PREFIX}${bytesToBase64Url(digest)}`
  if (!isCommunityDeliveryOperationId(operationId)) {
    throw new Error("invalid derived community delivery operation id")
  }
  return operationId
}

export async function computeCommunityDeliveryDigestFromBodies(
  bodies: readonly string[],
): Promise<CommunityDeliveryDigest> {
  let byteLength = 0
  const encoded = bodies.map((body) => {
    const bytes = new TextEncoder().encode(body)
    byteLength += 4 + bytes.byteLength
    return bytes
  })
  const canonical = new Uint8Array(byteLength)
  const view = new DataView(canonical.buffer)
  let offset = 0
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.byteLength, false)
    offset += 4
    canonical.set(bytes, offset)
    offset += bytes.byteLength
  }
  return bytesToHex(await sha256(canonical))
}

export async function prepareCommunityDeliveryEvents(
  values: readonly unknown[],
): Promise<CommunityDeliveryPrepareResult> {
  if (values.length < 1 || values.length > MESSAGE_DELIVERY_MAX_EVENTS_PER_USER) {
    return { ok: false, reason: "invalid-event-count" }
  }
  const events: CommunityWsEvent[] = []
  const envelopes: CommunityWsEvent[] = []
  const bodies: string[] = []
  for (let eventIndex = 0; eventIndex < values.length; eventIndex += 1) {
    const decoded = decodeCommunityBrowserEvent(values[eventIndex])
    if (!decoded.ok) return { ok: false, reason: "invalid-child", eventIndex }
    const encoded = encodeCommunityBrowserEvent(decoded.event)
    if (!encoded.ok) {
      return {
        ok: false,
        reason: encoded.reason === "oversized" ? "oversized-child" : "invalid-child",
        eventIndex,
        ...(encoded.byteLength === undefined ? {} : { byteLength: encoded.byteLength }),
      }
    }
    events.push(decoded.event)
    envelopes.push(encoded.event)
    bodies.push(encoded.body)
  }
  return {
    ok: true,
    prepared: {
      events,
      envelopes,
      bodies,
      digest: await computeCommunityDeliveryDigestFromBodies(bodies),
    },
  }
}

export async function encodeCommunityBrowserEventBatch(input: {
  operationId: unknown
  operationDigest: unknown
  events: readonly unknown[]
}): Promise<CommunityBrowserEventBatchEncodeResult> {
  if (!isCommunityDeliveryOperationId(input.operationId)) {
    return { ok: false, reason: "invalid-operation-id" }
  }
  if (!isCommunityDeliveryDigest(input.operationDigest)) {
    return { ok: false, reason: "invalid-operation-digest" }
  }
  const prepared = await prepareCommunityDeliveryEvents(input.events)
  if (!prepared.ok) return prepared
  return encodePreparedCommunityBrowserEventBatch({
    operationId: input.operationId,
    operationDigest: input.operationDigest,
    prepared: prepared.prepared,
  })
}

export function encodePreparedCommunityBrowserEventBatch(input: {
  operationId: unknown
  operationDigest: unknown
  prepared: PreparedCommunityDeliveryEvents
  sourceDigest?: CommunityDeliveryDigest
}): CommunityBrowserEventBatchEncodeResult {
  if (!isCommunityDeliveryOperationId(input.operationId)) {
    return { ok: false, reason: "invalid-operation-id" }
  }
  if (!isCommunityDeliveryDigest(input.operationDigest)) {
    return { ok: false, reason: "invalid-operation-digest" }
  }
  if (input.prepared.digest !== input.operationDigest) {
    return {
      ok: false,
      reason: "digest-mismatch",
      actualDigest: input.prepared.digest,
    }
  }
  if (input.sourceDigest !== undefined && !isCommunityDeliveryDigest(input.sourceDigest)) return { ok: false, reason: "invalid-operation-digest" }
  const envelope = {
    type: communityBrowserEventBatchType(input.sourceDigest === undefined ? 1 : COMMUNITY_CONTRACT_VERSION),
    operationId: input.operationId,
    operationDigest: input.sourceDigest ?? input.operationDigest,
    ...(input.sourceDigest === undefined ? {} : { wireDigest: input.prepared.digest }),
  }
  const prefix = JSON.stringify(envelope).slice(0, -1)
  const body = `${prefix},"events":[${input.prepared.bodies.join(",")}]}`
  const byteLength = utf8ByteLength(body)
  if (byteLength > COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES) {
    return { ok: false, reason: "batch-invariant-oversized", byteLength }
  }
  const batch: CommunityBrowserEventBatch = {
    ...envelope,
    events: input.prepared.envelopes,
  }
  return { ok: true, batch, body, byteLength, childBodies: input.prepared.bodies }
}

export function isCommunityBrowserEventBatchCandidate(
  value: unknown,
): value is Record<string, unknown> & { type: ReturnType<typeof communityBrowserEventBatchType> } {
  return isRecord(value) && (value.type === COMMUNITY_BROWSER_EVENT_BATCH_TYPE || value.type === communityBrowserEventBatchType())
}

export function decodeCommunityBrowserEventBatch(
  value: unknown,
  encodedByteLength?: number,
): CommunityBrowserEventBatchDecodeResult {
  const byteLength = encodedByteLength ?? utf8ByteLength(JSON.stringify(value))
  if (byteLength > COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES) {
    return { ok: false, reason: "oversized", byteLength }
  }
  if (!isRecord(value)) return { ok: false, reason: "non-object" }
  if (typeof value.type !== "string" || value.type.length === 0) {
    return { ok: false, reason: "missing-type" }
  }
  if (value.type !== COMMUNITY_BROWSER_EVENT_BATCH_TYPE && value.type !== communityBrowserEventBatchType()) {
    return { ok: false, reason: "wrong-type" }
  }
  if (!isCommunityDeliveryOperationId(value.operationId)) {
    return { ok: false, reason: "invalid-operation-id" }
  }
  if (!isCommunityDeliveryDigest(value.operationDigest)) {
    return { ok: false, reason: "invalid-operation-digest" }
  }
  const current = value.type === communityBrowserEventBatchType()
  if (
    Object.keys(value).length !== (current ? 5 : 4)
    || (current && !isCommunityDeliveryDigest(value.wireDigest))
    || !Object.hasOwn(value, "type")
    || !Object.hasOwn(value, "operationId")
    || !Object.hasOwn(value, "operationDigest")
    || !Object.hasOwn(value, "events")
  ) {
    return { ok: false, reason: "invalid-payload" }
  }
  if (
    !Array.isArray(value.events)
    || value.events.length < 1
    || value.events.length > MESSAGE_DELIVERY_MAX_EVENTS_PER_USER
  ) {
    return { ok: false, reason: "invalid-event-count" }
  }
  const events: CommunityWsEvent[] = []
  const envelopes: CommunityWsEvent[] = []
  for (let eventIndex = 0; eventIndex < value.events.length; eventIndex += 1) {
    const child = decodeCommunityBrowserEvent(value.events[eventIndex])
    if (!child.ok) {
      return { ok: false, reason: "invalid-child", eventIndex }
    }
    events.push(child.event)
    envelopes.push(child.event)
  }
  return {
    ok: true,
    batch: {
      type: value.type,
      ...(current ? { wireDigest: value.wireDigest as string } : {}),
      operationId: value.operationId,
      operationDigest: value.operationDigest,
      events: envelopes,
    },
    events,
  }
}

export function projectCommunityEventForContract(event: CommunityWsEvent, contract: CommunityContract): CommunityWsEvent | null {
  if (contract === COMMUNITY_CONTRACT_VERSION) return event
  if (event.type === "community:friend.block") return { type: event.type, userId: event.userId }
  if (event.type !== "community:channel.membership.change") return event
  if (event.serverId === null) return null
  return { type: event.present ? "community:channel.member_add" : "community:channel.member_remove",
    serverId: event.serverId, channelId: event.channelId, userId: event.userId }
}

export async function encodeCommunityBrowserEventBatchForContract(input: {
  operationId: CommunityDeliveryOperationId; prepared: PreparedCommunityDeliveryEvents; contract: CommunityContract;
}): Promise<CommunityBrowserEventBatchEncodeResult> {
  const source = await prepareCommunityDeliveryEvents(input.prepared.events)
  if (!source.ok) return source
  if (source.prepared.digest !== input.prepared.digest) return { ok: false, reason: "digest-mismatch", actualDigest: source.prepared.digest }
  const events = input.prepared.events.map((event) => projectCommunityEventForContract(event, input.contract))
  if (events.some((event) => event === null)) return { ok: false, reason: "invalid-child" }
  const wire = await prepareCommunityDeliveryEvents(events)
  if (!wire.ok) return wire
  return encodePreparedCommunityBrowserEventBatch({ operationId: input.operationId, operationDigest: wire.prepared.digest,
    prepared: wire.prepared, ...(input.contract === COMMUNITY_CONTRACT_VERSION ? { sourceDigest: input.prepared.digest } : {}) })
}

export function admitCommunityBrowserEventBatch(value: unknown): CommunityBrowserEventBatchDecodeResult | Promise<CommunityBrowserEventBatchDecodeResult> {
  const decoded = decodeCommunityBrowserEventBatch(value)
  if (!decoded.ok || decoded.batch.type === COMMUNITY_BROWSER_EVENT_BATCH_TYPE) return decoded
  return computeCommunityDeliveryDigestFromBodies((value as { events: unknown[] }).events.map((event) => JSON.stringify(event)))
    .then((digest) => digest === decoded.batch.wireDigest ? decoded : { ok: false, reason: "invalid-payload" })
}
