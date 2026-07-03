import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannel = vi.fn()
const mockGetMember = vi.fn()
const mockListChildChannels = vi.fn()
const mockGetMessagesByIds = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockGetFirstMessageByChannelIds = vi.fn()
const mockGetMessage = vi.fn()
const mockGetUser = vi.fn()
const mockListMessages = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
      },
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessagesByIds: (...a: unknown[]) => mockGetMessagesByIds(...a),
        getFirstMessageByChannelIds: (...a: unknown[]) => mockGetFirstMessageByChannelIds(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      user: {
        getUser: (...a: unknown[]) => mockGetUser(...a),
        getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
      },
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function req(url = "http://localhost/api/community/channels/c1/threads") {
  return new NextRequest(url, { method: "GET" })
}

const ctx = { params: { id: "c1" } } as any

describe("GET /api/community/channels/[id]/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMember.mockResolvedValue({ id: "m1", userId: "u1", serverId: "s1" })
  })

  it("resolves parent/creator/first-message via three batched calls (never per-item)", async () => {
    // Fixture: 3 threads.
    //   thread-A: parent message (parentMessageId set)
    //   thread-B: creator only, has a first message
    //   thread-C: creator only, no first message
    mockListChildChannels.mockResolvedValue([
      {
        id: "t-A",
        name: "A",
        type: "thread",
        messageCount: 3,
        lastMessageAt: "2026-06-30T01:00:00.000Z",
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: "msg-p",
        creatorId: null,
      },
      {
        id: "t-B",
        name: "B",
        type: "thread",
        messageCount: 2,
        lastMessageAt: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: null,
        creatorId: "u-b",
      },
      {
        id: "t-C",
        name: "C",
        type: "thread",
        messageCount: 1,
        lastMessageAt: null,
        createdAt: "2026-06-30T00:00:00.000Z",
        parentMessageId: null,
        creatorId: "u-c",
      },
    ])
    mockGetMessagesByIds.mockResolvedValue([
      {
        id: "msg-p",
        content: "parent-content",
        authorName: "Alice",
        authorEmail: "a@t.com",
      },
    ])
    mockGetUsersByIds.mockResolvedValue([
      { id: "u-b", name: "Bob" },
      { id: "u-c", name: "Carol" },
    ])
    mockGetFirstMessageByChannelIds.mockResolvedValue([
      { channelId: "t-B", content: "first-in-B" },
    ])

    const res = await GET(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { threads: Array<{ id: string; parent: { authorName: string; text: string } }> }

    expect(body.threads).toEqual([
      { id: "t-A", name: "A", kind: "thread", messageCount: 3, lastMessageAt: "2026-06-30T01:00:00.000Z", parent: { authorName: "Alice", text: "parent-content" } },
      { id: "t-B", name: "B", kind: "thread", messageCount: 2, lastMessageAt: "2026-06-30T00:00:00.000Z", parent: { authorName: "Bob", text: "first-in-B" } },
      { id: "t-C", name: "C", kind: "thread", messageCount: 1, lastMessageAt: "2026-06-30T00:00:00.000Z", parent: { authorName: "Carol", text: "" } },
    ])

    expect(mockGetMessagesByIds).toHaveBeenCalledTimes(1)
    expect(mockGetUsersByIds).toHaveBeenCalledTimes(1)
    expect(mockGetFirstMessageByChannelIds).toHaveBeenCalledTimes(1)

    // Ensure the deprecated per-item fetches never fire.
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockGetUser).not.toHaveBeenCalled()
    expect(mockListMessages).not.toHaveBeenCalled()
  })
})
