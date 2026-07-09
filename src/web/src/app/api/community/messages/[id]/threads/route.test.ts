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
    mockGetMessage.mockResolvedValue({
      id: "msg-p",
      authorId: "u-author",
      content: "the parent content",
      channelId: "c-parent",
    })
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
  })

  it("creates the child channel WITHOUT cloning the parent message into it", async () => {
    const res = await POST(req({ name: "my thread" }), ctx)
    expect(res.status).toBe(201)

    // Regression guard: the fix in finding #6 removes the createMessage(...)
    // clone. If someone adds it back, this assertion fails and the drift
    // problem (parent edits, attachments/reactions/mentions lost) returns.
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

    // The CHILD_CHANNEL_CREATE fan-out fires with the new thread id.
    expect(mockFanOutToChannel).toHaveBeenCalledWith(
      "c-parent",
      expect.objectContaining({ parentMessageId: "msg-p" }),
      expect.anything(),
    )
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

  it("403s when the caller isn't a member of the parent channel's server", async () => {
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await POST(req({ name: "x" }), ctx)
    expect(res.status).toBe(403)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })
})
