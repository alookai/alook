import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_DELIVERY_OPERATION_ID_HEADER,
  MESSAGE_DELIVERY_MAX_EVENTS_PER_USER,
  deriveCommunityDeliveryOperationId,
  type MessageDeliveryBatch,
} from "@alook/shared"
import { createCommunityDeliveryReceipt } from "../community-delivery-receipt"
import { INTERNAL_USER_TARGET_HEADER } from "../internal-user-broadcast"
import {
  createRouterTestContext,
  loadRouter,
  type RouterHandler,
  type RouterTestContext,
} from "./test-harness"

const messageEvent = {
  type: "community:message.create" as const,
  channelId: "thread-1",
  serverId: "server-1",
  parentChannelId: "forum-1",
  message: {
    id: "message-1",
    seq: 4,
    authorId: "author",
    authorName: "Alice",
    authorAvatarVersion: 0,
    content: "hello",
    type: "chat" as const,
    createdAt: "2026-08-18T00:00:00.000Z",
  },
}

const batch = {
  messageId: "message-1",
  messageEvent,
  contentUserIds: ["author", "overlap"],
  unreadPlainUserIds: [],
  unreadMentionUserIds: ["overlap"],
  mentionUserIds: ["overlap", "mention-only"],
  memberAdded: { userId: "author", serverId: "server-1", channelId: "thread-1" },
  parentProjection: {
    type: "community:channel.child_update" as const,
    parentChannelId: "forum-1",
    channelId: "thread-1",
    changes: { messageCount: 4, lastMessageAt: "2026-08-18T00:00:00.000Z" },
  },
  parentProjectionUserIds: ["overlap", "parent-only"],
}

type InternalBundleBody = {
  operationId: string
  operationDigest: string
  events: Array<{ type: string; [key: string]: unknown }>
}

async function successfulReceipt(request: Request): Promise<Response> {
  const body = await request.clone().json() as InternalBundleBody
  return Response.json(createCommunityDeliveryReceipt({
    status: "complete",
    operationId: body.operationId,
    operationDigest: body.operationDigest,
    eventCount: body.events.length,
    results: [],
  }))
}

async function deliveryRequest(value: MessageDeliveryBatch = batch): Promise<Request> {
  return new Request("http://localhost/broadcast/community/message-delivery", {
    method: "POST",
    headers: {
      [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: await deriveCommunityDeliveryOperationId(value.messageId),
    },
    body: JSON.stringify(value),
  })
}

describe("message delivery route", () => {
  let handler: RouterHandler
  let doMock: RouterTestContext["doMock"]
  let env: RouterTestContext["env"]

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const context = createRouterTestContext()
    doMock = context.doMock
    env = context.env
    handler = await loadRouter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("inverts buckets into one ordered bundle per user", async () => {
    doMock.stubFetch.mockImplementation(successfulReceipt)

    const response = await handler.fetch(await deliveryRequest(), env as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ failedUserIds: [] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(4)
    const calls = await Promise.all(doMock.stubFetch.mock.calls.map(async ([request]) => {
      const req = request as Request
      return {
        userId: decodeURIComponent(req.headers.get(INTERNAL_USER_TARGET_HEADER)!),
        body: await req.clone().json() as InternalBundleBody,
      }
    }))
    expect(calls).toContainEqual({
      userId: "overlap",
      body: expect.objectContaining({
        operationId: await deriveCommunityDeliveryOperationId("message-1"),
        operationDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        events: expect.arrayContaining([]),
      }),
    })
    const byUser = new Map(calls.map((call) => [call.userId, call.body]))
    expect(byUser.get("overlap")?.events.map((event) => event.type)).toEqual([
      "community:message.create",
      "community:unread.bump",
      "community:mention.create",
      "community:channel.child_update",
    ])
    expect(byUser.get("mention-only")?.events.map((event) => event.type)).toEqual([
      "community:unread.bump",
      "community:mention.create",
    ])
    expect(byUser.get("mention-only")?.events[0]).toMatchObject({
      channelId: "thread-1",
      serverId: "server-1",
      railChannelId: "forum-1",
      isMention: true,
    })
    // Exact legacy strict shape: scope travels on the pre-existing bump so an
    // already-open client running the previous decoder accepts the whole batch.
    expect(byUser.get("mention-only")?.events[1]).toEqual({
      type: "community:mention.create",
      userId: "mention-only",
      messageId: "message-1",
      channelId: "thread-1",
      authorName: "Alice",
    })
    expect(byUser.get("overlap")?.events.filter((event) => (
      event.type === "community:unread.bump"
    ))).toHaveLength(1)
    expect(byUser.get("parent-only")?.events.map((event) => event.type)).toEqual(["community:channel.child_update"])
    expect(new Set(calls.map((call) => call.body.operationId))).toEqual(new Set([
      await deriveCommunityDeliveryOperationId("message-1"),
    ]))
    expect(calls.every((call) => (
      call.body.events.length <= MESSAGE_DELIVERY_MAX_EVENTS_PER_USER
    ))).toBe(true)
    expect(byUser.get("author")?.operationDigest).not.toBe(byUser.get("overlap")?.operationDigest)
  })

  it("returns an exact failed subset while healthy siblings complete", async () => {
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId === "overlap") return new Response("bad", { status: 502 })
      return successfulReceipt(request)
    })

    const response = await handler.fetch(await deliveryRequest(), env as never)

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(4)
  })

  it("keeps the operation ID and per-user digest stable after an accepted enqueue response is lost", async () => {
    const mentionOnlyBodies: InternalBundleBody[] = []
    let mentionOnlyAttempts = 0
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId !== "mention-only") return successfulReceipt(request)
      const body = await request.clone().json() as InternalBundleBody
      mentionOnlyBodies.push(body)
      mentionOnlyAttempts += 1
      if (mentionOnlyAttempts === 1) return new Response("")
      return successfulReceipt(request)
    })

    const retryBatch = {
      ...batch,
      contentUserIds: [],
      unreadMentionUserIds: [],
      mentionUserIds: ["mention-only"],
      memberAdded: undefined,
      parentProjectionUserIds: ["mention-only"],
    }
    const first = await handler.fetch(await deliveryRequest(retryBatch), env as never)
    expect(first.status).toBe(207)
    await expect(first.json()).resolves.toEqual({ failedUserIds: ["mention-only"] })

    const retry = await handler.fetch(await deliveryRequest(retryBatch), env as never)
    expect(retry.status).toBe(200)
    expect(mentionOnlyBodies).toHaveLength(2)
    expect(mentionOnlyBodies[1]).toEqual(mentionOnlyBodies[0])
    expect(mentionOnlyBodies[0]?.events).toHaveLength(3)
  })

  it("keeps a mention-only DM scoped as a DM in the legacy-compatible batch", async () => {
    doMock.stubFetch.mockImplementation(successfulReceipt)
    const dmBatch = {
      ...batch,
      messageEvent: {
        ...batch.messageEvent,
        channelId: "dm-1",
        serverId: undefined,
        parentChannelId: undefined,
      },
      contentUserIds: [],
      unreadMentionUserIds: [],
      mentionUserIds: ["mention-only"],
      memberAdded: undefined,
      parentProjection: undefined,
      parentProjectionUserIds: undefined,
    }

    const response = await handler.fetch(await deliveryRequest(dmBatch), env as never)
    expect(response.status).toBe(200)
    const request = doMock.stubFetch.mock.calls[0]?.[0] as Request
    const body = await request.clone().json() as InternalBundleBody
    expect(body.events).toEqual([
      {
        type: "community:unread.bump",
        userId: "mention-only",
        channelId: "dm-1",
        isMention: true,
      },
      {
        type: "community:mention.create",
        userId: "mention-only",
        messageId: "message-1",
        channelId: "dm-1",
        authorName: "Alice",
      },
    ])
  })

  it("accepts only the operation ID derived from the committed message", async () => {
    doMock.stubFetch.mockImplementation(successfulReceipt)
    const expected = await deriveCommunityDeliveryOperationId(batch.messageId)
    const accepted = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      {
        method: "POST",
        headers: { [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: expected },
        body: JSON.stringify(batch),
      },
    ), env as never)
    expect(accepted.status).toBe(200)

    doMock.stubFetch.mockClear()
    const mismatch = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      {
        method: "POST",
        headers: {
          [COMMUNITY_DELIVERY_OPERATION_ID_HEADER]: await deriveCommunityDeliveryOperationId("other-message"),
        },
        body: JSON.stringify(batch),
      },
    ), env as never)
    expect(mismatch.status).toBe(400)
    expect(doMock.stubFetch).not.toHaveBeenCalled()

    const missing = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)
    expect(missing.status).toBe(400)
    await expect(missing.json()).resolves.toMatchObject({ reason: "operation-id-mismatch" })
  })

  it("rejects a committed message ID that cannot produce an operation ID", async () => {
    const invalidMessageId = "\ud800"
    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      {
        method: "POST",
        body: JSON.stringify({
          ...batch,
          messageId: invalidMessageId,
          messageEvent: {
            ...batch.messageEvent,
            message: { ...batch.messageEvent.message, id: invalidMessageId },
          },
        }),
      },
    ), env as never)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid-message-id" })
    expect(doMock.stubFetch).not.toHaveBeenCalled()
  })

  it.each([
    ["throws", () => Promise.reject(new Error("DO unavailable"))],
    ["returns invalid JSON", () => Promise.resolve(new Response("not-json"))],
    ["returns an invalid receipt", () => Promise.resolve(Response.json({ accepted: -1 }))],
  ])("returns only the failed target when one user DO %s", async (_label, failedResponse) => {
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId === "overlap") return failedResponse()
      return successfulReceipt(request)
    })

    const response = await handler.fetch(await deliveryRequest(), env as never)

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(4)
  })

  it("classifies a complete receipt with frameCount=2 as invalid and returns the target in 207", async () => {
    const frameCount = 2
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId !== "overlap") return successfulReceipt(request)
      const body = await request.clone().json() as InternalBundleBody
      return Response.json(createCommunityDeliveryReceipt({
        status: "complete",
        operationId: body.operationId,
        operationDigest: body.operationDigest,
        eventCount: body.events.length,
        results: [{
          socketIndex: 0,
          outcome: "enqueued",
          frameCount,
          persistedNextFrameIndex: frameCount,
          ambiguousClosed: false,
        }],
      }))
    })

    const response = await handler.fetch(await deliveryRequest(), env as never)
    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
  })

  it("delivers the maximum 1,000 distinct targets exactly once", async () => {
    const userIds = Array.from({ length: 1_000 }, (_, index) => `user-${index}`)
    doMock.stubFetch.mockImplementation(successfulReceipt)
    const response = await handler.fetch(await deliveryRequest({
      ...batch,
      contentUserIds: userIds,
      unreadPlainUserIds: [],
      unreadMentionUserIds: [],
      mentionUserIds: [],
      memberAdded: undefined,
      parentProjection: undefined,
      parentProjectionUserIds: undefined,
    }), env as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ failedUserIds: [] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(1_000)
  })

  it.each([
    ["invalid JSON", "{"],
    ["extra key", JSON.stringify({ ...batch, extra: true })],
    ["cross-scope member", JSON.stringify({ ...batch, memberAdded: { ...batch.memberAdded, channelId: "other" } })],
  ])("rejects %s before DO access", async (_label, body) => {
    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body },
    ), env as never)
    expect(response.status).toBe(400)
    expect(doMock.stubFetch).not.toHaveBeenCalled()
  })
})
