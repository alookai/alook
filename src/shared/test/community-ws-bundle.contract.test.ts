import { describe, expect, it, vi } from "vitest"
import {
  BUSINESS_SCHEMA_VERSION,
  projectCommunityEventForContract,
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
import { communityWsEventFixtures, communityResourceMessageFixture } from "./community-ws-events.fixtures"

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
  it("derives one current wire name and rejects old or invalid contracts", () => {
    expect(communityBrowserEventBatchType()).toBe(`community:events.batch.v${BUSINESS_SCHEMA_VERSION}`)
    expect(communityBrowserEventBatchType(BUSINESS_SCHEMA_VERSION)).toBe(`community:events.batch.v${BUSINESS_SCHEMA_VERSION}`)
    for (const contract of [0, 1, 2, 3, BUSINESS_SCHEMA_VERSION - 1]) expect(() => communityBrowserEventBatchType(contract)).toThrow("unsupported community event contract")
  })
  it("uses identical source and wire digests with no old membership projection", async () => {
    const change = { type: WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE, channelId: "thread", serverId: "server", userId: "joined", relation: "notify", present: true } as const
    const prepared = await prepareCommunityDeliveryEvents([change])
    if (!prepared.ok) throw new Error("invalid fixture")
    const operationId = await deriveCommunityDeliveryOperationId("joined-message")
    await expect(encodeCommunityBrowserEventBatchForContract({ operationId, prepared: { ...prepared.prepared, digest: "0".repeat(64) }, contract: BUSINESS_SCHEMA_VERSION })).resolves.toMatchObject({ ok: false, reason: "digest-mismatch" })
    const current = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: BUSINESS_SCHEMA_VERSION })
    if (!current.ok) throw new Error("invalid current fixture")
    expect(current.batch.events).toEqual([{ ...change, schemaVersion: BUSINESS_SCHEMA_VERSION }])
    expect(current.batch).toMatchObject({ operationDigest: prepared.prepared.digest, wireDigest: prepared.prepared.digest })
    expect(await admitCommunityBrowserEventBatch(JSON.parse(current.body))).toMatchObject({ ok: true, events: [change] })
    for (const contract of [1, 2, 3]) await expect(encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract })).resolves.toMatchObject({ ok: false, reason: "invalid-contract" })
    for (const fields of [{ operationDigest: "0".repeat(64) }, { wireDigest: "0".repeat(64) }, { events: [{ ...change, present: false, schemaVersion: BUSINESS_SCHEMA_VERSION }] }]) expect(await admitCommunityBrowserEventBatch({ ...current.batch, ...fields })).toMatchObject({ ok: false })
    expect(await admitCommunityBrowserEventBatch({ ...current.batch, events: [{ ...current.batch.events[0], extra: true }] })).toMatchObject({ ok: false })
  })
  it.each([false, true])("retains current owned Block=%s without projecting old peer shapes", async blockedByViewer => {
    const event = { type: WS_EVENTS.FRIEND_BLOCK, userId: "peer", blockedByViewer } as const
    const prepared = await prepareCommunityDeliveryEvents([event])
    if (!prepared.ok) throw new Error("invalid block fixture")
    const operationId = await deriveCommunityDeliveryOperationId("blocked-peer")
    const current = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: BUSINESS_SCHEMA_VERSION })
    if (!current.ok) throw new Error("invalid current fixture")
    expect(current.batch.events).toEqual([{ ...event, schemaVersion: BUSINESS_SCHEMA_VERSION }])
    expect(await admitCommunityBrowserEventBatch(current.batch)).toMatchObject({ ok: true, events: [event] })
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
    expect(encoded.batch.type).toBe(communityBrowserEventBatchType())
    expect(Object.keys(encoded.batch).sort()).toEqual([
      "events",
      "operationDigest",
      "operationId",
      "type",
      "wireDigest",
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


describe("current full-resource delivery codec", () => {
  it("captures current child bytes and rejects every obsolete projection", async () => {
    const prepared = await prepareCommunityDeliveryEvents([communityResourceMessageFixture])
    if (!prepared.ok) throw new Error("invalid current fixture")
    expect(prepared.prepared.contract).toBe(BUSINESS_SCHEMA_VERSION)
    expect(JSON.parse(prepared.prepared.bodies[0]!)).toEqual({ ...communityResourceMessageFixture, schemaVersion: BUSINESS_SCHEMA_VERSION })
    const operationId = await deriveCommunityDeliveryOperationId("full-resource")
    for (const contract of [1, 2, 3]) {
      await expect(prepareCommunityDeliveryEvents([communityResourceMessageFixture], contract)).resolves.toMatchObject({ ok: false })
      await expect(encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract })).resolves.toMatchObject({ ok: false, reason: "invalid-contract" })
      expect(encodePreparedCommunityBrowserEventBatch({ operationId, operationDigest: prepared.prepared.digest, prepared: prepared.prepared, contract })).toMatchObject({ ok: false, reason: "invalid-contract" })
    }
    const encoded = await encodeCommunityBrowserEventBatchForContract({ operationId, prepared: prepared.prepared, contract: BUSINESS_SCHEMA_VERSION })
    if (!encoded.ok) throw new Error("invalid current frame")
    expect(encoded.byteLength).toBe(utf8ByteLength(encoded.body))
    expect(await admitCommunityBrowserEventBatch(JSON.parse(encoded.body))).toMatchObject({ ok: true, events: [communityResourceMessageFixture] })
    const tampered = JSON.parse(encoded.body)
    tampered.events[0].message.attachments.reverse()
    expect(await admitCommunityBrowserEventBatch(tampered)).toMatchObject({ ok: false })
    for (const type of ["community:events.batch", "community:events.batch.v2", "community:events.batch.v3"]) expect(await admitCommunityBrowserEventBatch({ ...encoded.batch, type })).toMatchObject({ ok: false })
  })
})

it("projects only a validated current event with matching source and recipient contracts", () => {
  const event = communityWsEventFixtures["community:message.create"]
  expect(projectCommunityEventForContract(event, BUSINESS_SCHEMA_VERSION)).toEqual(event)
  expect(projectCommunityEventForContract(event, BUSINESS_SCHEMA_VERSION - 1)).toBeNull()
  expect(projectCommunityEventForContract(event, BUSINESS_SCHEMA_VERSION, BUSINESS_SCHEMA_VERSION - 1)).toBeNull()
  expect(projectCommunityEventForContract({ ...event, message: { ...event.message, avatarVersion: 4 } } as never, BUSINESS_SCHEMA_VERSION)).toBeNull()
})
