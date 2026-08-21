import { describe, expect, it } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_BATCH_CONTRACT_VERSION,
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_DELIVERY_OPERATION_ID_BYTES,
  COMMUNITY_EVENTS_BATCH_CAPABILITY,
  computeCommunityDeliveryDigestFromBodies,
  decodeCommunityBrowserEventBatch,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEvent,
  encodeCommunityBrowserEventBatch,
  isCommunityBrowserEventBatchCandidate,
  isCommunityDeliveryDigest,
  isCommunityDeliveryOperationId,
  prepareCommunityDeliveryEvents,
  utf8ByteLength,
  WS_EVENTS,
  type CommunityBotAuditEvent,
  type CommunityWsEvent,
} from "../src"
import { communityWsEventFixtures } from "./community-ws-events.fixtures"

function maximizeAuditPadding(): CommunityBotAuditEvent {
  let low = 0
  let high = COMMUNITY_BROWSER_EVENT_MAX_BYTES
  let best: CommunityBotAuditEvent | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const event: CommunityBotAuditEvent = {
      ...communityWsEventFixtures["community:bot.audit_event"],
      payload: { padding: "x".repeat(mid) },
    }
    const encoded = encodeCommunityBrowserEvent(event)
    if (encoded.ok) {
      best = event
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (!best) throw new Error("audit fixture cannot fit")
  return best
}

describe("community WS batch transport contract", () => {
  const children: CommunityWsEvent[] = [
    communityWsEventFixtures["community:message.create"],
    communityWsEventFixtures["community:unread.bump"],
    communityWsEventFixtures["community:mention.create"],
  ]

  it("locks operation ID grammar and SHA-256 vectors", async () => {
    await expect(deriveCommunityDeliveryOperationId("message-1")).resolves.toBe(
      "message:neuIC0O99vRloK-xMK7XGzHPIZYm82N_V31BZ82A5fI",
    )
    await expect(deriveCommunityDeliveryOperationId("é-message")).resolves.toBe(
      "message:tg9ymYSdoZdumzg9P_Hu-TJVaZJSHEtJ6Iib_JRy71w",
    )
    await expect(deriveCommunityDeliveryOperationId("")).rejects.toThrow("invalid community delivery message id")
    await expect(deriveCommunityDeliveryOperationId("\ud800")).rejects.toThrow("invalid community delivery message id")
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    expect(utf8ByteLength(operationId)).toBe(COMMUNITY_DELIVERY_OPERATION_ID_BYTES)
    expect(isCommunityDeliveryOperationId(operationId)).toBe(true)
    expect(isCommunityDeliveryOperationId(`${operationId}x`)).toBe(false)
    expect(isCommunityDeliveryOperationId(`Message:${operationId.slice(8)}`)).toBe(false)
  })

  it("locks the length-prefixed canonical digest vector", async () => {
    await expect(computeCommunityDeliveryDigestFromBodies([
      '{"a":1}',
      '{"b":"é"}',
    ])).resolves.toBe("65171f224e0fa5a07f436b80d1f4b0bd1bcaf790d6c20998d1f8aad95ad54d2c")
    expect(isCommunityDeliveryDigest("a".repeat(64))).toBe(true)
    expect(isCommunityDeliveryDigest("A".repeat(64))).toBe(false)
    expect(isCommunityDeliveryDigest("a".repeat(63))).toBe(false)
  })

  it("round-trips one strict outer frame without entering the 41-event union", async () => {
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const prepared = await prepareCommunityDeliveryEvents(children)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const encoded = await encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      events: children,
    })
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(encoded.batch).toEqual(JSON.parse(encoded.body))
    expect(encoded.batch.type).toBe(COMMUNITY_BROWSER_EVENT_BATCH_TYPE)
    expect(encoded.batch.contractVersion).toBe(COMMUNITY_BROWSER_EVENT_BATCH_CONTRACT_VERSION)
    expect(encoded.batch.events.map((event) => event.type)).toEqual(children.map((event) => event.type))
    expect(decodeCommunityBrowserEventBatch(encoded.batch, encoded.byteLength)).toEqual({
      ok: true,
      batch: encoded.batch,
      events: children,
    })
    expect(isCommunityBrowserEventBatchCandidate(encoded.batch)).toBe(true)
    expect(Object.values(WS_EVENTS)).not.toContain(COMMUNITY_BROWSER_EVENT_BATCH_TYPE)
    expect(Object.values(WS_EVENTS)).toHaveLength(41)
    expect(COMMUNITY_EVENTS_BATCH_CAPABILITY).toBe("community-events-batch-v1")
  })

  it("rejects invalid count, child, operation metadata, digest mismatch, and strict outer keys", async () => {
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const prepared = await prepareCommunityDeliveryEvents(children)
    if (!prepared.ok) throw new Error("fixture must prepare")

    await expect(encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      events: [],
    })).resolves.toMatchObject({ ok: false, reason: "invalid-event-count" })
    await expect(encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      events: Array.from({ length: 6 }, () => children[0]),
    })).resolves.toMatchObject({ ok: false, reason: "invalid-event-count" })
    await expect(encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      events: [...children, { type: "community:future" }],
    })).resolves.toMatchObject({ ok: false, reason: "invalid-child", eventIndex: 3 })
    await expect(encodeCommunityBrowserEventBatch({
      operationId: "message:short",
      operationDigest: prepared.prepared.digest,
      events: children,
    })).resolves.toMatchObject({ ok: false, reason: "invalid-operation-id" })
    await expect(encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: "A".repeat(64),
      events: children,
    })).resolves.toMatchObject({ ok: false, reason: "invalid-operation-digest" })
    await expect(encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: "0".repeat(64),
      events: children,
    })).resolves.toMatchObject({ ok: false, reason: "digest-mismatch" })

    const encoded = await encodeCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      events: children,
    })
    if (!encoded.ok) throw new Error("fixture must encode")
    expect(decodeCommunityBrowserEventBatch({ ...encoded.batch, extra: true })).toMatchObject({
      ok: false,
      reason: "invalid-payload",
    })
    expect(decodeCommunityBrowserEventBatch({ ...encoded.batch, contractVersion: 2 })).toMatchObject({
      ok: false,
      reason: "unsupported-version",
      contractVersion: 2,
    })
    expect(decodeCommunityBrowserEventBatch({ ...encoded.batch, events: [] })).toMatchObject({
      ok: false,
      reason: "invalid-event-count",
    })
    expect(decodeCommunityBrowserEventBatch({
      ...encoded.batch,
      events: [{ ...encoded.batch.events[0], contractVersion: undefined }],
    })).toMatchObject({ ok: false, reason: "invalid-child", eventIndex: 0 })
    expect(decodeCommunityBrowserEventBatch(encoded.batch, COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES + 1)).toEqual({
      ok: false,
      reason: "oversized",
      byteLength: COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES + 1,
    })
  })

  it("proves five maximum legal children fit the exact outer ceiling", async () => {
    const maxChild = maximizeAuditPadding()
    const maxChildEncoded = encodeCommunityBrowserEvent(maxChild)
    expect(maxChildEncoded.ok).toBe(true)
    if (!maxChildEncoded.ok) return
    expect(maxChildEncoded.byteLength).toBe(COMMUNITY_BROWSER_EVENT_MAX_BYTES)
    const events = Array.from({ length: 5 }, () => maxChild)
    const prepared = await prepareCommunityDeliveryEvents(events)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const encoded = await encodeCommunityBrowserEventBatch({
      operationId: await deriveCommunityDeliveryOperationId("maximum-operation"),
      operationDigest: prepared.prepared.digest,
      events,
    })
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(encoded.childBodies.every((body) => utf8ByteLength(body) === COMMUNITY_BROWSER_EVENT_MAX_BYTES)).toBe(true)
    expect(encoded.byteLength).toBeLessThanOrEqual(COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES)
    expect(COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES - encoded.byteLength).toBeGreaterThanOrEqual(0)
    expect(decodeCommunityBrowserEventBatch(encoded.batch, encoded.byteLength)).toMatchObject({ ok: true })
  })
})
