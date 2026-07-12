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
const mockGetUserInternal = vi.fn()

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
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
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
    mockGetUserInternal.mockResolvedValue({ id: "u1", name: "Thread Creator" })
    // The thread-creation system message (see #12/§5 — inserted into the
    // PARENT channel, distinct from the parent-message-clone-into-the-NEW-
    // thread-channel bug finding #6 already guards against below).
    mockCreateMessage.mockResolvedValue({ id: "sysmsg-1" })
    mockGetMessage.mockImplementation((_db, id) => {
      if (id === "sysmsg-1") {
        return Promise.resolve({
          id: "sysmsg-1",
          authorId: "u1",
          authorName: "Thread Creator",
          authorImage: null,
          content: "Thread Creator started a thread: my thread",
          type: "thread_created",
          mentionType: null,
          replyToId: null,
          embeds: null,
          createdAt: "2026-07-03T00:00:01.000Z",
        })
      }
      return Promise.resolve({
        id: "msg-p",
        authorId: "u-author",
        content: "the parent content",
        channelId: "c-parent",
      })
    })
  })

  it("creates the child channel WITHOUT cloning the parent message into it", async () => {
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)

    // Regression guard: the fix in finding #6 removes the createMessage(...)
    // CLONE of the parent's content into the NEW thread channel — that call
    // would have `channelId: "t-new"`. It's distinct from the (correct,
    // added in #12/§5) system-message insert into the PARENT channel
    // (`channelId: "c-parent"`) asserted below — this checks no call
    // targets the new thread channel specifically.
    expect(mockCreateMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: "t-new" }),
    )

    // The new system-message insert targets the PARENT channel, with the
    // `thread_created` convention type (#12/§5).
    expect(mockCreateMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channelId: "c-parent", type: "thread_created" }),
    )

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

    // Both fan-outs to the parent channel fire: CHILD_CHANNEL_CREATE and the
    // new system-message MESSAGE_CREATE (#12/§5).
    expect(mockFanOutToChannel).toHaveBeenCalledWith(
      "c-parent",
      expect.objectContaining({ parentMessageId: "msg-p" }),
      expect.anything(),
    )
    // The system-message broadcast is NOT given `excludeUserId` — unlike the
    // creator's own client-side actions elsewhere, nothing inserts this row
    // into the creator's local cache, so they need the WS broadcast too to
    // see "started a thread" without a refresh (verification acceptance
    // finding #6 in community-message-tech-debt-acceptance.md).
    expect(mockFanOutToChannel).toHaveBeenCalledWith(
      "c-parent",
      expect.objectContaining({
        type: "community:message.create",
        message: expect.objectContaining({ id: "sysmsg-1", type: "system", systemKind: "thread" }),
      }),
      expect.objectContaining({ excludeUserId: undefined }),
    )
    const systemMessageCall = mockFanOutToChannel.mock.calls.find(
      (call) => (call[1] as { type?: string }).type === "community:message.create",
    )
    expect(systemMessageCall).toBeDefined()
    // The unified pipeline passes an opts arg; `includeAuthorInFanout` means
    // no `excludeUserId` so the creator also receives the broadcast.
    expect((systemMessageCall![2] as { excludeUserId?: string }).excludeUserId).toBeUndefined()
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
})
