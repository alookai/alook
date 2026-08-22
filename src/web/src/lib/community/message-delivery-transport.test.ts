import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_DELIVERY_OPERATION_ID_HEADER,
  MESSAGE_DELIVERY_BODY_MAX_BYTES,
  deriveCommunityDeliveryOperationId,
  type MessageDeliveryBatch,
} from "@alook/shared"

const {
  bindingFetch,
  logInfo,
  logError,
} = vi.hoisted(() => ({
  bindingFetch: vi.fn<(...args: unknown[]) => Promise<Response>>(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: {
      WS_DO_WORKER: { fetch: bindingFetch },
      DEV_WS_DO_URL: "http://dev-ws:8789",
    },
    ctx: { waitUntil: vi.fn() },
  }),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: (...args: unknown[]) => logInfo(...args),
      warn: vi.fn(),
      error: (...args: unknown[]) => logError(...args),
      debug: vi.fn(),
    }),
  }
})

import { sendMessageDeliveryBatch } from "./message-delivery-transport"

const originalFetch = globalThis.fetch
const globalFetch = vi.fn<(...args: unknown[]) => Promise<Response>>()

function batch(overrides: Partial<MessageDeliveryBatch> = {}): MessageDeliveryBatch {
  return {
    messageId: "message-1",
    messageEvent: {
      type: "community:message.create",
      channelId: "thread-1",
      serverId: "server-1",
      parentChannelId: "forum-1",
      message: {
        id: "message-1",
        seq: 4,
        authorId: "u1",
        authorName: "Alice",
        content: "hello",
        type: "chat",
        createdAt: "2026-08-18T00:00:00.000Z",
      },
    },
    contentUserIds: ["u1", "u2", "u3"],
    unreadPlainUserIds: ["u2"],
    unreadMentionUserIds: ["u3"],
    mentionUserIds: ["u3"],
    memberAdded: { userId: "u1", serverId: "server-1", channelId: "thread-1" },
    parentProjection: {
      type: "community:channel.child_update",
      parentChannelId: "forum-1",
      channelId: "thread-1",
      changes: { messageCount: 4, lastMessageAt: "2026-08-18T00:00:00.000Z" },
    },
    parentProjectionUserIds: ["u1", "parent-only"],
    ...overrides,
  }
}

function requestBatch(callIndex: number): MessageDeliveryBatch {
  const init = bindingFetch.mock.calls[callIndex]?.[1] as RequestInit
  return JSON.parse(init.body as string) as MessageDeliveryBatch
}

function requestOperationId(callIndex: number): string | null {
  const init = bindingFetch.mock.calls[callIndex]?.[1] as RequestInit
  return new Headers(init.headers).get(COMMUNITY_DELIVERY_OPERATION_ID_HEADER)
}

beforeEach(() => {
  vi.clearAllMocks()
  globalThis.fetch = globalFetch as unknown as typeof fetch
  bindingFetch.mockImplementation(async () => Response.json({ failedUserIds: [] }))
})

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe("sendMessageDeliveryBatch", () => {
  it("sends one valid batch when target and byte limits both fit", async () => {
    await sendMessageDeliveryBatch(batch())

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(String(bindingFetch.mock.calls[0]?.[0])).toBe(
      "http://internal/broadcast/community/message-delivery",
    )
    expect(requestBatch(0)).toEqual(batch())
    expect(requestOperationId(0)).toBe(await deriveCommunityDeliveryOperationId("message-1"))
  })

  it("rejects a caller-supplied operation ID that does not match the committed message", async () => {
    await expect(sendMessageDeliveryBatch(
      batch(),
      await deriveCommunityDeliveryOperationId("different-message"),
    )).rejects.toThrow("operation ID does not match message")
    expect(bindingFetch).not.toHaveBeenCalled()
  })

  it("chunks 1,000 targets without dropping or duplicating a target", async () => {
    const ids = Array.from({ length: 1_000 }, (_, index) => `user-${index}`)
    await sendMessageDeliveryBatch(batch({
      contentUserIds: ids,
      unreadPlainUserIds: [],
      unreadMentionUserIds: [],
      mentionUserIds: [],
      memberAdded: undefined,
      parentProjection: undefined,
      parentProjectionUserIds: undefined,
    }))

    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(requestBatch(0).contentUserIds).toEqual(ids)
  })

  it("splits fewer than 1,000 targets when repeated escaped ids exceed the byte cap", async () => {
    const ids = Array.from(
      { length: 500 },
      (_, index) => `u${index}-${String.fromCharCode(1).repeat(120)}`,
    )
    const oversized = batch({
      contentUserIds: ids,
      unreadPlainUserIds: [],
      unreadMentionUserIds: ids,
      mentionUserIds: ids,
      memberAdded: undefined,
      parentProjectionUserIds: ids,
    })

    await sendMessageDeliveryBatch(oversized)

    expect(bindingFetch.mock.calls.length).toBeGreaterThan(1)
    const delivered = bindingFetch.mock.calls.flatMap((_, index) => requestBatch(index).contentUserIds)
    expect(delivered).toEqual(ids)
    for (const call of bindingFetch.mock.calls) {
      const init = call[1] as RequestInit
      expect(new TextEncoder().encode(init.body as string).byteLength)
        .toBeLessThanOrEqual(MESSAGE_DELIVERY_BODY_MAX_BYTES)
    }
    expect(new Set(bindingFetch.mock.calls.map((_, index) => requestOperationId(index))))
      .toEqual(new Set([await deriveCommunityDeliveryOperationId("message-1")]))
  })

  it("fails closed when even a single-target batch is oversized", async () => {
    const oversized = batch({
      messageEvent: {
        ...batch().messageEvent,
        message: {
          ...batch().messageEvent.message,
          content: "x".repeat(MESSAGE_DELIVERY_BODY_MAX_BYTES),
        },
      },
      contentUserIds: ["u1"],
      unreadPlainUserIds: [],
      unreadMentionUserIds: [],
      mentionUserIds: [],
      memberAdded: undefined,
      parentProjection: undefined,
      parentProjectionUserIds: undefined,
    })

    await expect(sendMessageDeliveryBatch(oversized)).rejects.toThrow(/oversized/)
    expect(bindingFetch).not.toHaveBeenCalled()
  })

  it("accepts an exact 207 subset and retries only failed users", async () => {
    bindingFetch
      .mockResolvedValueOnce(Response.json({ failedUserIds: ["u2"] }, { status: 207 }))
      .mockResolvedValueOnce(Response.json({ failedUserIds: [] }))

    await sendMessageDeliveryBatch(batch())

    expect(bindingFetch).toHaveBeenCalledTimes(2)
    expect(requestBatch(1)).toMatchObject({
      contentUserIds: ["u2"],
      unreadPlainUserIds: ["u2"],
      unreadMentionUserIds: [],
      mentionUserIds: [],
    })
    expect(requestBatch(1).memberAdded).toBeUndefined()
    expect(requestBatch(1).parentProjection).toBeUndefined()
    expect(requestOperationId(1)).toBe(requestOperationId(0))
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("stops after the initial attempt plus two failed-only retries", async () => {
    bindingFetch.mockImplementation(
      async () => Response.json({ failedUserIds: ["u2"] }, { status: 207 }),
    )

    await expect(sendMessageDeliveryBatch(batch())).rejects.toThrow(/failed for 1 chunk/)
    expect(bindingFetch).toHaveBeenCalledTimes(3)
    expect(requestBatch(1).contentUserIds).toEqual(["u2"])
    expect(requestBatch(2).contentUserIds).toEqual(["u2"])
    expect(requestOperationId(1)).toBe(requestOperationId(0))
    expect(requestOperationId(2)).toBe(requestOperationId(0))
  })

  it.each([
    { name: "non-JSON", response: () => new Response("nope", { status: 207 }) },
    { name: "empty subset", response: () => Response.json({ failedUserIds: [] }, { status: 207 }) },
    { name: "duplicate", response: () => Response.json({ failedUserIds: ["u2", "u2"] }, { status: 207 }) },
    { name: "outside request", response: () => Response.json({ failedUserIds: ["outside"] }, { status: 207 }) },
    { name: "extra key", response: () => Response.json({ failedUserIds: ["u2"], extra: true }, { status: 207 }) },
  ])("fails closed on a malformed 207: $name", async ({ response }) => {
    bindingFetch.mockResolvedValue(response())

    await expect(sendMessageDeliveryBatch(batch())).rejects.toThrow(/failed for 1 chunk/)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it.each([404, 405])("fails closed when ws-do lacks the batch route (%i)", async (status) => {
    bindingFetch.mockResolvedValue(new Response("route unavailable", { status }))
    await expect(sendMessageDeliveryBatch(batch())).rejects.toThrow(/failed for 1 chunk/)
    expect(bindingFetch).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("uses only the binding/dev fallback transport after a binding 5xx or throw", async () => {
    bindingFetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    globalFetch.mockResolvedValueOnce(Response.json({ failedUserIds: [] }))
    await sendMessageDeliveryBatch(batch())

    bindingFetch.mockRejectedValueOnce(new Error("binding unavailable"))
    globalFetch.mockResolvedValueOnce(Response.json({ failedUserIds: [] }))
    await sendMessageDeliveryBatch(batch())

  })

  it("does not enter legacy mode for an invalid successful response", async () => {
    bindingFetch.mockResolvedValue(new Response("not json", { status: 200 }))

    await expect(sendMessageDeliveryBatch(batch())).rejects.toThrow(/failed for 1 chunk/)
  })
})
