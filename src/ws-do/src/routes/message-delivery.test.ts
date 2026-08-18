import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const body = await request.clone().json() as { events: unknown[] }
      return Response.json({ accepted: body.events.length })
    })

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
        types: ((await req.clone().json()) as { events: Array<{ type: string }> }).events.map((event) => event.type),
      }
    }))
    expect(calls).toContainEqual({
      userId: "overlap",
      types: [
        "community:message.create",
        "community:unread.bump",
        "community:mention.create",
        "community:channel.child_update",
      ],
    })
    expect(calls).toContainEqual({ userId: "mention-only", types: ["community:mention.create"] })
    expect(calls).toContainEqual({ userId: "parent-only", types: ["community:channel.child_update"] })
  })

  it("returns an exact failed subset while healthy siblings complete", async () => {
    doMock.stubFetch.mockImplementation(async (request: Request) => {
      const userId = decodeURIComponent(request.headers.get(INTERNAL_USER_TARGET_HEADER)!)
      if (userId === "overlap") return new Response("bad", { status: 502 })
      const body = await request.clone().json() as { events: unknown[] }
      return Response.json({ accepted: body.events.length })
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
