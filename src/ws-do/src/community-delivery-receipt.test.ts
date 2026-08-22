import { describe, expect, it } from "vitest"
import { deriveCommunityDeliveryOperationId } from "@alook/shared"
import {
  createCommunityDeliveryReceipt,
  isExactCommunityDeliveryReceipt,
} from "./community-delivery-receipt"

describe("community delivery receipt conservation", () => {
  it("accepts only an exact complete receipt whose aggregates project from results", async () => {
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const operationDigest = "a".repeat(64)
    const receipt = createCommunityDeliveryReceipt({
      status: "complete",
      operationId,
      operationDigest,
      eventCount: 3,
      results: [
        {
          socketIndex: 0,
          outcome: "enqueued",
          frameCount: 1,
          persistedNextFrameIndex: 1,
          ambiguousClosed: false,
        },
        {
          socketIndex: 1,
          outcome: "alreadyEnqueued",
          frameCount: 1,
          persistedNextFrameIndex: 1,
          ambiguousClosed: false,
        },
      ],
    })
    const expected = { operationId, operationDigest, eventCount: 3 }
    expect(isExactCommunityDeliveryReceipt(receipt, expected)).toBe(true)
    expect(isExactCommunityDeliveryReceipt({ ...receipt, matched: 3 }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({ ...receipt, extra: true }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      results: [{ ...receipt.results[0], persistedNextFrameIndex: 0 }, receipt.results[1]],
    }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      ambiguousClosed: 1,
      results: [{ ...receipt.results[0], ambiguousClosed: true }, receipt.results[1]],
    }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      results: [{
        ...receipt.results[0],
        frameCount: 2,
        persistedNextFrameIndex: 2,
      }, receipt.results[1]],
    }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      partial: 1,
      enqueued: 0,
      results: [{
        ...receipt.results[0],
        outcome: "partial",
        persistedNextFrameIndex: 0,
      }, receipt.results[1]],
    }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      alreadyEnqueued: 0,
      partial: 1,
      results: [receipt.results[0], {
        ...receipt.results[1],
        outcome: "partial",
        persistedNextFrameIndex: receipt.results[1].frameCount,
      }],
    }, expected)).toBe(false)
    expect(isExactCommunityDeliveryReceipt({
      ...receipt,
      alreadyEnqueued: 0,
    }, expected)).toBe(false)
  })

  it("does not accept incomplete or ambiguous receipts as router success", async () => {
    const operationId = await deriveCommunityDeliveryOperationId("message-1")
    const operationDigest = "b".repeat(64)
    const receipt = createCommunityDeliveryReceipt({
      status: "incomplete",
      operationId,
      operationDigest,
      eventCount: 1,
      results: [{
        socketIndex: 0,
        outcome: "failed",
        frameCount: 1,
        persistedNextFrameIndex: 0,
        ambiguousClosed: true,
      }],
    })
    expect(isExactCommunityDeliveryReceipt(receipt, {
      operationId,
      operationDigest,
      eventCount: 1,
    })).toBe(false)
  })
})
