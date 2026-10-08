import { describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES,
  COMMUNITY_BROWSER_EVENT_BATCH_TYPE,
  communityBrowserEventBatchType,
  encodeCommunityBrowserEventBatchForContract,
  admitCommunityBrowserEventBatch,
  COMMUNITY_BROWSER_EVENT_MAX_BYTES,
  COMMUNITY_DELIVERY_OPERATION_ID_BYTES,
  computeCommunityDeliveryDigestFromBodies,
  decodeCommunityBrowserEventBatch,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEvent,
  encodeCommunityBrowserEventBatch,
  encodePreparedCommunityBrowserEventBatch,
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
  it("derives both wire names from one family and the supported contract", () => {
    expect(communityBrowserEventBatchType(1)).toBe("community:events.batch")
    expect(communityBrowserEventBatchType()).toBe("community:events.batch.v2")
    expect(communityBrowserEventBatchType(2)).toBe("community:events.batch.v2")
    expect(() => communityBrowserEventBatchType(0)).toThrow("unsupported community event contract")
    expect(() => communityBrowserEventBatchType(3)).toThrow("unsupported community event contract")
  })
  it("keeps the source digest while projecting one strict format per connection", async () => {
    const change = { type: WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE, channelId: "thread", serverId: "server", userId: "joined", relation: "notify", present: true } as const
    const prepared = await prepareCommunityDeliveryEvents([change])
    if (!prepared.ok) throw new Error("invalid fixture")
    const operationId = await deriveCommunityDeliveryOperationId("joined-message")
    for (const contract of [1, 2] as const) {
      await expect(encodeCommunityBrowserEventBatchForContract({ operationId, prepared: { ...prepared.prepared, digest: "0".repeat(64) }, contract }))
        .resolves.toMatchObject({ ok: false, reason: "digest-mismatch" })
    }
    const old = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: 1 })
    const current = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: 2 })
    if (!old.ok || !current.ok) throw new Error("invalid projection")
    expect(old.body).toBe("{\"type\":\"community:events.batch\",\"operationId\":\"message:qbWQs0jZgHxxQP2XnrG_JaBwIEH7tss-wN83NwGGFco\",\"operationDigest\":\"02f419257acb00e467b673a0d10295eacaa0176c6f6700926ced78aabd78f053\",\"events\":[{\"type\":\"community:channel.member_add\",\"serverId\":\"server\",\"channelId\":\"thread\",\"userId\":\"joined\"}]}")
    expect(old.byteLength).toBe(296)
    expect(current.body).toBe("{\"type\":\"community:events.batch.v2\",\"operationId\":\"message:qbWQs0jZgHxxQP2XnrG_JaBwIEH7tss-wN83NwGGFco\",\"operationDigest\":\"256d83c615e1feac6685548ba38cfa9296913b0e0b64fd11ec8d4331711390b6\",\"wireDigest\":\"256d83c615e1feac6685548ba38cfa9296913b0e0b64fd11ec8d4331711390b6\",\"events\":[{\"type\":\"community:channel.membership.change\",\"channelId\":\"thread\",\"serverId\":\"server\",\"userId\":\"joined\",\"relation\":\"notify\",\"present\":true}]}")
    expect(current.byteLength).toBe(421)
    expect(admitCommunityBrowserEventBatch(old.batch)).not.toBeInstanceOf(Promise)
    expect(admitCommunityBrowserEventBatch(old.batch)).toMatchObject({ ok: true })
    expect(admitCommunityBrowserEventBatch(current.batch)).toBeInstanceOf(Promise)
    expect(old.batch.type).toBe(COMMUNITY_BROWSER_EVENT_BATCH_TYPE)
    expect(Object.keys(old.batch)).toHaveLength(4)
    expect(old.batch.events).toEqual([{ type: WS_EVENTS.CHANNEL_MEMBER_ADD, serverId: "server", channelId: "thread", userId: "joined" }])
    expect(old.batch.operationDigest).not.toBe(prepared.prepared.digest)
    expect(current.batch).toMatchObject({ type: communityBrowserEventBatchType(), operationDigest: prepared.prepared.digest, wireDigest: prepared.prepared.digest })
    expect(await admitCommunityBrowserEventBatch(JSON.parse(current.body))).toMatchObject({ ok: true })
    expect(decodeCommunityBrowserEventBatch({ ...old.batch, wireDigest: current.batch.wireDigest }).ok).toBe(false)
    const tampered = JSON.parse(current.body)
    tampered.events[0].present = false
    expect(await admitCommunityBrowserEventBatch(tampered)).toMatchObject({ ok: false })
    const invalid = JSON.parse(current.body)
    invalid.events[0].extra = true
    expect(await admitCommunityBrowserEventBatch(invalid)).toMatchObject({ ok: false })
  })
  it.each([false, true])("keeps owned Block=%s in the current wire and emits the original peer shape for legacy", async (blockedByViewer) => {
    const event = { type: WS_EVENTS.FRIEND_BLOCK, userId: "peer", blockedByViewer } as const
    const prepared = await prepareCommunityDeliveryEvents([event])
    if (!prepared.ok) throw new Error("invalid block fixture")
    const operationId = await deriveCommunityDeliveryOperationId("blocked-peer")
    const old = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: 1 })
    const current = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: 2 })
    if (!old.ok || !current.ok) throw new Error("invalid block projection")
    expect(old.batch.events).toEqual([{ type: WS_EVENTS.FRIEND_BLOCK, userId: "peer" }])
    expect(current.batch.events).toEqual([event])
    expect(await admitCommunityBrowserEventBatch(current.batch)).toMatchObject({ ok: true })
  })

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
    await expect(deriveCommunityDeliveryOperationId("emoji-😀")).resolves.toMatch(/^message:/)
    await expect(deriveCommunityDeliveryOperationId("")).rejects.toThrow("invalid community delivery message id")
    await expect(deriveCommunityDeliveryOperationId("\ud800")).rejects.toThrow("invalid community delivery message id")
    await expect(deriveCommunityDeliveryOperationId("\udc00")).rejects.toThrow("invalid community delivery message id")
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    expect(utf8ByteLength(operationId)).toBe(COMMUNITY_DELIVERY_OPERATION_ID_BYTES)
    expect(isCommunityDeliveryOperationId(operationId)).toBe(true)
    expect(isCommunityDeliveryOperationId(`${operationId}x`)).toBe(false)
    expect(isCommunityDeliveryOperationId(`Message:${operationId.slice(8)}`)).toBe(false)
  })

  it("fails closed if the SHA-256 runtime violates the fixed operation-ID invariant", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockResolvedValueOnce(new ArrayBuffer(1))
    try {
      await expect(deriveCommunityDeliveryOperationId("message-runtime-fault"))
        .rejects.toThrow("invalid derived community delivery operation id")
    } finally {
      digest.mockRestore()
    }
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

  it("round-trips one strict outer frame without entering the 46-event union", async () => {
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
    expect(Object.keys(encoded.batch).sort()).toEqual([
      "events",
      "operationDigest",
      "operationId",
      "type",
    ])
    expect(encoded.batch.events.map((event) => event.type)).toEqual(children.map((event) => event.type))
    expect(decodeCommunityBrowserEventBatch(encoded.batch, encoded.byteLength)).toEqual({
      ok: true,
      batch: encoded.batch,
      events: children,
    })
    expect(isCommunityBrowserEventBatchCandidate(encoded.batch)).toBe(true)
    expect(Object.values(WS_EVENTS)).not.toContain(COMMUNITY_BROWSER_EVENT_BATCH_TYPE)
    expect(Object.values(WS_EVENTS)).toHaveLength(46)
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
    await expect(prepareCommunityDeliveryEvents([{
      ...communityWsEventFixtures["community:bot.audit_event"],
      payload: { padding: "x".repeat(COMMUNITY_BROWSER_EVENT_MAX_BYTES) },
    }])).resolves.toMatchObject({ ok: false, reason: "oversized-child", eventIndex: 0 })
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
    expect(encodePreparedCommunityBrowserEventBatch({
      operationId: "message:short",
      operationDigest: prepared.prepared.digest,
      prepared: prepared.prepared,
    })).toMatchObject({ ok: false, reason: "invalid-operation-id" })
    expect(encodePreparedCommunityBrowserEventBatch({
      operationId,
      operationDigest: "A".repeat(64),
      prepared: prepared.prepared,
    })).toMatchObject({ ok: false, reason: "invalid-operation-digest" })
    expect(encodePreparedCommunityBrowserEventBatch({
      operationId,
      operationDigest: prepared.prepared.digest,
      prepared: {
        ...prepared.prepared,
        bodies: [`"${"x".repeat(COMMUNITY_BROWSER_EVENT_BATCH_MAX_BYTES)}"`],
      },
    })).toMatchObject({ ok: false, reason: "batch-invariant-oversized" })

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
    expect(decodeCommunityBrowserEventBatch(null)).toMatchObject({ ok: false, reason: "non-object" })
    expect(decodeCommunityBrowserEventBatch({})).toMatchObject({ ok: false, reason: "missing-type" })
    expect(decodeCommunityBrowserEventBatch({ type: "community:message.create" })).toMatchObject({
      ok: false,
      reason: "wrong-type",
    })
    expect(decodeCommunityBrowserEventBatch({ ...encoded.batch, events: [] })).toMatchObject({
      ok: false,
      reason: "invalid-event-count",
    })
    expect(decodeCommunityBrowserEventBatch({
      ...encoded.batch,
      operationId: "message:short",
    })).toMatchObject({ ok: false, reason: "invalid-operation-id" })
    expect(decodeCommunityBrowserEventBatch({
      ...encoded.batch,
      operationDigest: "A".repeat(64),
    })).toMatchObject({ ok: false, reason: "invalid-operation-digest" })
    expect(decodeCommunityBrowserEventBatch({
      ...encoded.batch,
      events: [{ ...encoded.batch.events[0], contractVersion: 1 }],
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
