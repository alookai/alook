import { describe, expect, it } from "vitest"
import { deriveCommunityDeliveryOperationId } from "@alook/shared"
import {
  preflightCommunityConnectionState,
  readCommunityDeliveryProgress,
  withCommunityDeliveryProgress,
} from "./community-delivery-state"
import {
  COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES,
  COMMUNITY_DELIVERY_PROGRESS_LIMIT,
  type UserConnectionState,
} from "./internal"

describe("community delivery connection attachment state", () => {
  it("keeps 64 compact entries under the application budget and evicts the oldest at 65", async () => {
    let state: UserConnectionState = {
      type: "user",
      userId: "u".repeat(64),
      targetUserId: "t".repeat(64),
      authenticated: true,
      name: "n".repeat(128),
      discriminator: "1234",
      communityEventsBatchV1: true,
    }
    const operationIds: string[] = []
    for (let index = 0; index < COMMUNITY_DELIVERY_PROGRESS_LIMIT; index += 1) {
      const operationId = await deriveCommunityDeliveryOperationId(`message-${index}`)
      operationIds.push(operationId)
      state = withCommunityDeliveryProgress(state, {
        operationId,
        operationDigest: index.toString(16).padStart(64, "0"),
        mode: index % 2 === 0 ? "batch" : "legacy",
        nextFrameIndex: 1,
        frameCount: 1,
      })
    }
    const preflight = preflightCommunityConnectionState(state)
    expect(preflight).toMatchObject({ ok: true })
    if (preflight.ok) expect(preflight.jsonByteLength).toBeLessThan(COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES)
    expect(readCommunityDeliveryProgress(state)).toMatchObject({
      ok: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ operationId: operationIds[0] }),
        expect.objectContaining({ operationId: operationIds[63] }),
      ]),
    })

    const sixtyFifth = await deriveCommunityDeliveryOperationId("message-64")
    state = withCommunityDeliveryProgress(state, {
      operationId: sixtyFifth,
      operationDigest: "f".repeat(64),
      mode: "batch",
      nextFrameIndex: 1,
      frameCount: 1,
    })
    const decoded = readCommunityDeliveryProgress(state)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.entries).toHaveLength(COMMUNITY_DELIVERY_PROGRESS_LIMIT)
    expect(decoded.entries[0].operationId).toBe(operationIds[1])
    expect(decoded.entries.at(-1)?.operationId).toBe(sixtyFifth)
    expect(preflightCommunityConnectionState(state)).toMatchObject({ ok: true })
  })

  it("fails closed for malformed, duplicate, non-cloneable, and over-budget states", async () => {
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const base: UserConnectionState = {
      type: "user",
      userId: "user-1",
      authenticated: true,
      communityDeliveryProgress: [[operationId, "a".repeat(64), 0, 1, 1]],
    }
    expect(preflightCommunityConnectionState({
      ...base,
      communityDeliveryProgress: [
        ...base.communityDeliveryProgress!,
        ...base.communityDeliveryProgress!,
      ],
    })).toMatchObject({ ok: false, reason: "invalid-progress" })
    expect(readCommunityDeliveryProgress({
      ...base,
      communityDeliveryProgress: Array.from(
        { length: COMMUNITY_DELIVERY_PROGRESS_LIMIT + 1 },
        () => base.communityDeliveryProgress![0],
      ),
    })).toEqual({ ok: false })
    expect(preflightCommunityConnectionState({
      ...base,
      name: "x".repeat(COMMUNITY_CONNECTION_STATE_JSON_MAX_BYTES),
    })).toMatchObject({ ok: false, reason: "json-budget" })
    expect(preflightCommunityConnectionState({
      ...base,
      name: (() => "not cloneable") as unknown as string,
    })).toMatchObject({ ok: false, reason: "not-cloneable" })
  })
})
