import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockGetMember = vi.fn()
const mockCreateChannelMember = vi.fn()
const mockListChannelMembers = vi.fn()
const mockGetPrivateChannelAudienceUserIds = vi.fn()
const mockGetUsersByIds = vi.fn()
const mockResolveScopeMembers = vi.fn()
const mockGetMembersByUserIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockLogAudit = vi.fn()
const mockAddThreadParticipants = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        createChannelMember: (...a: unknown[]) => mockCreateChannelMember(...a),
        listChannelMembers: (...a: unknown[]) => mockListChannelMembers(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        getMembersByUserIds: (...a: unknown[]) => mockGetMembersByUserIds(...a),
      },
      communityMembersResolver: {
        resolveScopeMembers: (...a: unknown[]) => mockResolveScopeMembers(...a),
      },
      communityThread: {
        addThreadParticipants: (...a: unknown[]) => mockAddThreadParticipants(...a),
      },
      user: { getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a) },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
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

import { GET, POST } from "./route"

const ctx = { params: { id: "c1" } } as any
function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/members", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// A private top-level channel the caller can manage (caller u1 is the creator).
function managerCtx() {
  return {
    channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "u1" },
    anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
    role: "member",
    isPrivate: true,
    isChannelMember: true,
    isCreator: true,
  }
}

describe("GET /channels/[id]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    // Full resolved audience: creator (u1), an added member (u2), an admin (u3).
    mockResolveScopeMembers.mockResolvedValue([
      { userId: "u1", role: "member", source: "explicit" },
      { userId: "u2", role: "member", source: "explicit" },
      { userId: "u3", role: "admin", source: "admin" },
    ])
    mockGetMembersByUserIds.mockResolvedValue([
      { id: "m1", serverId: "s1", userId: "u1", role: "member", nickname: null, userName: "Ann", userImage: null, discriminator: "0001", statusEmoji: null, statusText: null, userIsBot: false, userOwnerUserId: null },
      { id: "m2", serverId: "s1", userId: "u2", role: "member", nickname: null, userName: "Bob", userImage: null, discriminator: "0002", statusEmoji: null, statusText: null, userIsBot: false, userOwnerUserId: null },
      { id: "m3", serverId: "s1", userId: "u3", role: "admin", nickname: null, userName: "Cy", userImage: null, discriminator: "0003", statusEmoji: null, statusText: null, userIsBot: false, userOwnerUserId: null },
    ])
  })

  it("lists the full audience with role + source + isCreator", async () => {
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/members"), ctx)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.members).toHaveLength(3)
    const creator = body.members.find((m: any) => m.userId === "u1")
    expect(creator.isCreator).toBe(true)
    expect(creator.source).toBe("explicit")
    const added = body.members.find((m: any) => m.userId === "u2")
    expect(added.isCreator).toBe(false)
    expect(added.source).toBe("explicit")
    const admin = body.members.find((m: any) => m.userId === "u3")
    expect(admin.source).toBe("admin")
    expect(admin.role).toBe("admin")
  })

  it("drops audience members with no hydrated (non-deleted) server row", async () => {
    mockGetMembersByUserIds.mockResolvedValue([
      { id: "m1", serverId: "s1", userId: "u1", role: "member", nickname: null, userName: "Ann", userImage: null, discriminator: "0001", statusEmoji: null, statusText: null, userIsBot: false, userOwnerUserId: null },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/members"), ctx)
    const body = await res.json()
    expect(body.members).toHaveLength(1)
    expect(body.members[0].userId).toBe("u1")
  })

  it("resolves a thread to its anchor channel's audience", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "t1", serverId: "s1", parentChannelId: "c1", creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: true, isChannelMember: true,
    })
    const res = await GET(new NextRequest("http://localhost/api/community/channels/t1/members"), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)
    // scope resolves against the requested channel id (climbs internally).
    expect(mockResolveScopeMembers).toHaveBeenCalledWith(expect.anything(), { scope: "channel", scopeId: "t1" })
    // hydration is scoped to the anchor's server.
    expect(mockGetMembersByUserIds).toHaveBeenCalledWith(expect.anything(), "s1", expect.any(Array))
  })

  it("badges a forum post's OWN creator, not the forum owner", async () => {
    // Post p1 owned by u2; the forum (anchor) is owned by u1. The post roster
    // is u1 (forum owner, added as a member) + u2 (post creator).
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "p1", serverId: "s1", type: "forum_post", parentChannelId: "f1", parentMessageId: null, creatorId: "u2" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: false,
    })
    mockResolveScopeMembers.mockResolvedValue([
      { userId: "u1", role: "member", source: "explicit" },
      { userId: "u2", role: "member", source: "explicit" },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/channels/p1/members"), { params: { id: "p1" } } as any)
    const body = await res.json()
    // The post creator (u2) is the roster creator — NOT the forum owner (u1).
    expect(body.members.find((m: any) => m.userId === "u2").isCreator).toBe(true)
    expect(body.members.find((m: any) => m.userId === "u1").isCreator).toBe(false)
  })

  it("403 for a caller without access", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await GET(new NextRequest("http://localhost/api/community/channels/c1/members"), ctx)
    expect(res.status).toBe(403)
  })
})

describe("POST /channels/[id]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockGetMember.mockResolvedValue({ id: "m2", userId: "u2", role: "member" })
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"])
  })

  it("adds an existing server member", async () => {
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "c1", userId: "u2", addedBy: "u1",
    })
  })

  it("rejects adding a non-server-member (400)", async () => {
    mockGetMember.mockResolvedValue(null)
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("allows any current member (not just creator) to add", async () => {
    // Caller is a plain added member, not the creator — add is open to members.
    mockResolveChannelAccessContext.mockResolvedValue({ ...managerCtx(), creatorId: "other", channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "other" }, anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "other" }, isChannelMember: true, role: "member", isCreator: false })
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(201)
  })

  it("rejects a non-member outsider (403 from the access gate)", async () => {
    // resolveChannelAccessContext returns null for someone with no access.
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(403)
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("rejects adding to a public/uncategorized channel (400)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: false, isChannelMember: false,
    })
    const res = await POST(postReq({ userId: "u2" }), ctx)
    expect(res.status).toBe(400)
  })

  it("rejects adding on a thread channel (400)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "t1" } } as any)
    expect(res.status).toBe(400)
  })

  it("rejects adding to a FORUM (400): forum membership is derived from its posts", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "f1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "u1" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "f1" } } as any)
    expect(res.status).toBe(400)
    // A forum member row would never be read (access is the union of posts) —
    // the write must be rejected, not silently no-op.
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("allows adding to a private forum post (own access unit)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "p1", serverId: "s1", type: "forum_post", parentChannelId: "f1", parentMessageId: null, creatorId: "u1" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "p1" } } as any)
    expect(res.status).toBe(201)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "p1", userId: "u2", addedBy: "u1",
    })
    // Access → notify coupling: an added private-post member also joins the
    // post's participant (notify) set so they receive fan-out.
    expect(mockAddThreadParticipants).toHaveBeenCalledWith(expect.anything(), "p1", [
      { userId: "u2", source: "added" },
    ])
  })
})
