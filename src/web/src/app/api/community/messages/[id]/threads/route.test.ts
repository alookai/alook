import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMessage = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockListChildChannels = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockListMessages = vi.fn()
const mockAddThreadParticipants = vi.fn()

const mockFanOutToChannel = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
      },
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      communityThread: {
        addThreadParticipants: (...a: unknown[]) => mockAddThreadParticipants(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

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

import { POST } from "./route"
import { queries } from "@alook/shared"

function req(body: unknown) {
  return new NextRequest("http://localhost/api/community/messages/msg-p/threads", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const ctx = { params: { id: "msg-p" } } as any

describe("POST /api/community/messages/[id]/threads", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The unified pipeline fires `fanOutToChannel(...).catch(...)` — the mock
    // must return a promise so the `.catch` chain resolves.
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockAddThreadParticipants.mockResolvedValue(undefined)
    // Both the caller (u1) and the parent-message author (u-author) resolve as
    // members by default — the seeding path checks membership per userId.
    mockGetChannelForMember.mockResolvedValue({
      id: "c-parent",
      serverId: "s1",
    })
    mockListChildChannels.mockResolvedValue([])
    mockCreateChannel.mockResolvedValue({
      id: "t-new",
      name: "my thread",
      serverId: "s1",
      parentChannelId: "c-parent",
      parentMessageId: "msg-p",
      type: "thread",
      creatorId: "u1",
      messageCount: 0,
      createdAt: "2026-07-03T00:00:00.000Z",
    })
    mockGetMessage.mockResolvedValue({
      id: "msg-p",
      authorId: "u-author",
      content: "the parent content",
      channelId: "c-parent",
    })
  })

  it("creates the child channel WITHOUT inserting any message into either channel", async () => {
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)

    // No message row is created anywhere: no clone into the new thread
    // channel, and no "XXX started a thread: NAME" notice into the parent.
    expect(mockCreateMessage).not.toHaveBeenCalled()

    // Structural check: listMessages on the new thread channel is empty —
    // no opener clone row exists.
    mockListMessages.mockResolvedValue([])
    const listed = await queries.communityMessage.listMessages({} as never, {
      channelId: "t-new",
    })
    expect(listed).toEqual([])

    // The child channel keeps the parentMessageId pointer (single source of
    // truth for the opener).
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        parentChannelId: "c-parent",
        parentMessageId: "msg-p",
        type: "thread",
      }),
    )

    // Response is the child channel itself — not a message.
    const body = await res.json()
    expect(body.id).toBe("t-new")
    expect(body.parentMessageId).toBe("msg-p")

    // Only the CHILD_CHANNEL_CREATE fan-out fires to the parent channel — no
    // system-message MESSAGE_CREATE broadcast.
    expect(mockFanOutToChannel).toHaveBeenCalledTimes(1)
    expect(mockFanOutToChannel).toHaveBeenCalledWith(
      "c-parent",
      expect.objectContaining({ parentMessageId: "msg-p" }),
      expect.anything(),
    )
    const messageCreateCall = mockFanOutToChannel.mock.calls.find(
      (call) => (call[1] as { type?: string }).type === "community:message.create",
    )
    expect(messageCreateCall).toBeUndefined()
  })

  it("rejects a second thread on the same parent message", async () => {
    mockListChildChannels.mockResolvedValue([
      { id: "t-existing", parentMessageId: "msg-p", type: "thread" },
    ])
    const res = await POST(req({ name: "second thread" }), ctx)
    expect(res.status).toBe(409)
    expect(mockCreateChannel).not.toHaveBeenCalled()
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("400s when the parent message has no channelId (DM parent isn't threadable)", async () => {
    mockGetMessage.mockResolvedValue({
      id: "msg-p",
      authorId: "u-author",
      content: "dm content",
      channelId: null,
      dmConversationId: "dm-1",
    })
    const res = await POST(req({ name: "x" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("404s when the parent message doesn't exist", async () => {
    mockGetMessage.mockResolvedValue(null)
    const res = await POST(req({ name: "x" }), ctx)
    expect(res.status).toBe(404)
  })

  it("400s when the parent message lives in a child channel (forum post / thread) — no grandchild threads", async () => {
    // A message inside a forum_post/thread: its channel has parentChannelId set.
    // Rooting a thread here would create a grandchild the single-level privacy
    // anchor climb can't resolve, leaking a private forum's thread server-wide.
    mockGetChannelForMember.mockResolvedValue({
      id: "forum-post-1",
      serverId: "s1",
      parentChannelId: "forum-1",
    })
    const res = await POST(req({ name: "x" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("403s when the caller isn't a member of the parent channel's server", async () => {
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(req({ name: "x" }), ctx)
    expect(res.status).toBe(403)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })

  it("seeds the creator (spoke) AND the parent-message author (added) as default participants", async () => {
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)
    expect(mockAddThreadParticipants).toHaveBeenCalledTimes(1)
    const [, threadId, rows] = mockAddThreadParticipants.mock.calls[0] as [
      unknown,
      string,
      { userId: string; source: string }[],
    ]
    expect(threadId).toBe("t-new")
    // Creator uses "spoke" (matches the forum-post creation flow); the author
    // was pulled in by someone else, so "added".
    expect(rows).toEqual([
      { userId: "u1", source: "spoke" },
      { userId: "u-author", source: "added" },
    ])
  })

  it("de-dupes when the creator threads their own message (one 'spoke' row, no duplicate)", async () => {
    mockGetMessage.mockResolvedValue({
      id: "msg-p",
      authorId: "u1",
      content: "my own message",
      channelId: "c-parent",
    })
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)
    const [, , rows] = mockAddThreadParticipants.mock.calls[0] as [
      unknown,
      string,
      { userId: string; source: string }[],
    ]
    expect(rows).toEqual([{ userId: "u1", source: "spoke" }])
  })

  it("does NOT seed the author when they've lost access to the parent channel", async () => {
    // Caller (u1) resolves as a member; the author (u-author) does not — the
    // per-userId getChannelForMember returns null for them, so seeding skips
    // the author to avoid pushing a private thread to a non-member.
    mockGetChannelForMember.mockImplementation(async (_db: unknown, _channelId: string, userId: string) => {
      if (userId === "u1") return { id: "c-parent", serverId: "s1" }
      return null
    })
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)
    const [, , rows] = mockAddThreadParticipants.mock.calls[0] as [
      unknown,
      string,
      { userId: string; source: string }[],
    ]
    expect(rows).toEqual([{ userId: "u1", source: "spoke" }])
  })
})
