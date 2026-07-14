import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockListThreadParticipants = vi.fn()
const mockAddThreadParticipant = vi.fn()
const mockResolveScopeMemberUserIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
      },
      communityMembersResolver: {
        resolveScopeMemberUserIds: (...a: unknown[]) => mockResolveScopeMemberUserIds(...a),
      },
      communityThread: {
        listThreadParticipants: (...a: unknown[]) => mockListThreadParticipants(...a),
        addThreadParticipant: (...a: unknown[]) => mockAddThreadParticipant(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
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

import { GET, POST } from "./route"

const ctx = { params: { id: "t1" } } as any
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/t1/participants", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// A thread the caller (u1) created, under parent channel c1.
function threadCtx(over: Record<string, unknown> = {}) {
  return {
    channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    ...over,
  }
}

describe("GET /channels/[id]/participants", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx())
    mockListThreadParticipants.mockResolvedValue([
      { userId: "u1", userName: "Ann", userImage: null, discriminator: "0001", source: "spoke" },
      { userId: "u2", userName: "Bob", userImage: null, discriminator: "0002", source: "mention" },
    ])
  })

  it("lists participants with source", async () => {
    const res = await GET(new NextRequest("http://localhost/api/community/channels/t1/participants"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.participants).toHaveLength(2)
    expect(body.participants[1]).toMatchObject({ userId: "u2", source: "mention" })
    expect(body.participants[1]).not.toHaveProperty("muted")
  })

  it("400 when the channel is not a thread", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({ channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "u1" } }))
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/participants"), ctx)
    expect(res.status).toBe(400)
  })

  it("403 for a caller who can't see the thread", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await GET(new NextRequest("http://localhost/api/community/channels/t1/participants"), ctx)
    expect(res.status).toBe(403)
  })
})

describe("POST /channels/[id]/participants", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx())
    // Parent-channel audience (same source the read gate/fan-out uses).
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockAddThreadParticipant.mockResolvedValue({ id: "tp1" })
  })

  it("any participant adds a parent-channel member as a participant", async () => {
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(201)
    expect(mockAddThreadParticipant).toHaveBeenCalledWith(expect.anything(), {
      threadChannelId: "t1", userId: "u2", source: "added",
    })
    expect(mockBroadcastToUserSafe).toHaveBeenCalled()
  })

  it("a non-creator participant can still add (no creator gate)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({ isCreator: false }))
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(201)
    expect(mockAddThreadParticipant).toHaveBeenCalled()
  })

  it("rejects adding someone not in the parent channel audience (400)", async () => {
    mockResolveScopeMemberUserIds.mockResolvedValue(["u1"]) // u2 not in parent
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
    expect(mockAddThreadParticipant).not.toHaveBeenCalled()
  })

  it("400 when the channel is not a thread", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(threadCtx({ channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "u1" } }))
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
  })
})
