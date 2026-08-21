import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  COMMUNITY_DELIVERY_OPERATION_ID_HEADER,
  deriveCommunityDeliveryOperationId,
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
  events: Array<{ type: string }>
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

    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)

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
    expect(byUser.get("mention-only")?.events.map((event) => event.type)).toEqual(["community:mention.create"])
    expect(byUser.get("parent-only")?.events.map((event) => event.type)).toEqual(["community:channel.child_update"])
    expect(new Set(calls.map((call) => call.body.operationId))).toEqual(new Set([
      await deriveCommunityDeliveryOperationId("message-1"),
    ]))
    expect(byUser.get("author")?.operationDigest).not.toBe(byUser.get("overlap")?.operationDigest)
  })

  it("returns an exact failed subset while healthy siblings complete", async () => {
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId === "overlap") return new Response("bad", { status: 502 })
      return successfulReceipt(request)
    })

    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(4)
  })

  it("keeps the operation ID and per-user digest stable after an accepted enqueue response is lost", async () => {
    const overlapBodies: InternalBundleBody[] = []
    let overlapAttempts = 0
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId !== "overlap") return successfulReceipt(request)
      const body = await request.clone().json() as InternalBundleBody
      overlapBodies.push(body)
      overlapAttempts += 1
      if (overlapAttempts === 1) return new Response("")
      return successfulReceipt(request)
    })

    const first = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)
    expect(first.status).toBe(207)
    await expect(first.json()).resolves.toEqual({ failedUserIds: ["overlap"] })

    const retryBatch = {
      ...batch,
      contentUserIds: ["overlap"],
      unreadMentionUserIds: ["overlap"],
      mentionUserIds: ["overlap"],
      memberAdded: undefined,
      parentProjectionUserIds: ["overlap"],
    }
    const retry = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(retryBatch) },
    ), env as never)
    expect(retry.status).toBe(200)
    expect(overlapBodies).toHaveLength(2)
    expect(overlapBodies[1]).toEqual(overlapBodies[0])
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

    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)

    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
    expect(doMock.stubFetch).toHaveBeenCalledTimes(4)
  })

  it.each([
    ["batch frameCount=2", "batch", 2],
    ["legacy frameCount differs from eventCount", "legacy", 1],
  ] as const)("classifies a complete receipt with %s as invalid and returns the target in 207", async (
    _label,
    mode,
    frameCount,
  ) => {
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
          mode,
          outcome: "enqueued",
          frameCount,
          persistedNextFrameIndex: frameCount,
          ambiguousClosed: false,
        }],
      }))
    })

    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      { method: "POST", body: JSON.stringify(batch) },
    ), env as never)
    expect(response.status).toBe(207)
    await expect(response.json()).resolves.toEqual({ failedUserIds: ["overlap"] })
  })

  it("delivers the maximum 1,000 distinct targets exactly once", async () => {
    const userIds = Array.from({ length: 1_000 }, (_, index) => `user-${index}`)
    doMock.stubFetch.mockImplementation(successfulReceipt)
    const response = await handler.fetch(new Request(
      "http://localhost/broadcast/community/message-delivery",
      {
        method: "POST",
        body: JSON.stringify({
          ...batch,
          contentUserIds: userIds,
          unreadPlainUserIds: [],
          unreadMentionUserIds: [],
          mentionUserIds: [],
          memberAdded: undefined,
          parentProjection: undefined,
          parentProjectionUserIds: undefined,
        }),
      },
    ), env as never)

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
