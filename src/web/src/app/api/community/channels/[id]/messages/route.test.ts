import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockListMembers = vi.fn()
const mockCreateMentions = vi.fn()
const mockCreateAttachment = vi.fn()
const mockListChildChannels = vi.fn()
const mockListMessages = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockBroadcastToUser = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
      },
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
      },
      communityMention: {
        createMentions: (...a: unknown[]) => mockCreateMentions(...a),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
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
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE } from "@alook/shared"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

const ctx = { params: { id: "c1" } } as any

describe("POST /api/community/channels/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockCreateMessage.mockResolvedValue({ id: "m1" })
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      authorEmail: "u1@t.com",
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
    mockListMembers.mockResolvedValue([])
    mockCreateMentions.mockResolvedValue(undefined)
    mockCreateAttachment.mockImplementation(async (_db: unknown, input: any) => ({
      id: "a1",
      ...input,
    }))
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
  })

  it("rejects content longer than MAX_MESSAGE_CONTENT_LENGTH with 400", async () => {
    const tooLong = "a".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
    const res = await POST(postReq({ content: tooLong }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("rejects more than MAX_ATTACHMENTS_PER_MESSAGE attachments with 400", async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({
      url: `r2://x/${i}`,
      filename: `f${i}.png`,
      contentType: "image/png",
      size: 1,
    }))
    const res = await POST(postReq({ content: "ok", attachments }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("fans out @everyone mention to every non-author member", async () => {
    mockListMembers.mockResolvedValue([
      { userId: "u1", userName: "Alice" },
      { userId: "u2", userName: "Bob" },
      { userId: "u3", userName: "Carol" },
    ])

    const res = await POST(postReq({ content: "hey team", mentionType: "everyone" }), ctx)

    expect(res.status).toBe(201)
    expect(mockCreateMentions).toHaveBeenCalledTimes(1)
    const [, payload] = mockCreateMentions.mock.calls[0]
    expect(payload.kind).toBe("mention")
    expect(payload.userIds.sort()).toEqual(["u2", "u3"])

    const broadcastTargets = mockBroadcastToUser.mock.calls.map((c) => c[0]).sort()
    expect(broadcastTargets).toEqual(["u2", "u3"])
  })
})
