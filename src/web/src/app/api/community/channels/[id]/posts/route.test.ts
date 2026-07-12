import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetChannelForMember = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetUserSelf = vi.fn()
const mockGetUserInternal = vi.fn()
const mockFanOutToChannel = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        // createCommunityMessage's private-channel scoping guard is only hit
        // when there are mentions; the happy-path posts have none, so these
        // return public/empty.
        isChannelPrivate: vi.fn(async () => false),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityMember: {
        listMembers: vi.fn(async () => []),
        listMemberUserIds: vi.fn(async () => []),
      },
      communityMention: {
        createMentions: vi.fn(async () => []),
      },
      user: {
        getUserSelf: (...a: unknown[]) => mockGetUserSelf(...a),
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: vi.fn(async () => {}),
}))

// createCommunityMessage's non-fanout side effects — stub so the pipeline runs.
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn(async () => {}),
}))
vi.mock("@/lib/community/audit", () => ({
  logAudit: vi.fn(),
  COMMUNITY_AUDIT_ACTIONS: { MESSAGE_AUTHORED_AS_BOT: "message_authored_as_bot" },
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
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

const ctx = { params: { id: "ch1" } } as any

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/ch1/posts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

describe("POST /api/community/channels/[id]/posts — name normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "ch1", serverId: "s1", type: "forum", tags: [] })
    mockCreateMessage.mockResolvedValue({ id: "m1", createdAt: "2026-07-02T00:00:00.000Z" })
    // createCommunityMessage re-fetches the row via getMessage after insert.
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      channelId: "post1",
      dmConversationId: null,
      seq: 1,
      createdAt: "2026-07-02T00:00:00.000Z",
    })
    mockGetUserSelf.mockResolvedValue({ id: "u1", name: "Alice", image: null })
    mockGetUserInternal.mockResolvedValue({ id: "u1", name: "Alice", isBot: false })
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  it("normalizes a spaced post title via slugify before creating the post channel", async () => {
    mockCreateChannel.mockResolvedValue({
      id: "post1",
      name: "My-thoughts-on-this!",
      createdAt: "2026-07-02T00:00:00.000Z",
    })

    const res = await POST(postReq({ name: "My thoughts on this!", content: "hello" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "My-thoughts-on-this!" }),
    )
  })

  it("returns 400 (and never calls createChannel) when the post title is all disallowed characters", async () => {
    const res = await POST(postReq({ name: "///", content: "hello" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannel).not.toHaveBeenCalled()
  })
})
