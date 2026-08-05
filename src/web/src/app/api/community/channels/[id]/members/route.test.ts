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
const mockListThreadParticipants = vi.fn()
const mockListThreadParticipantUserIds = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockGetServer = vi.fn()
const mockFetchOnlineUserIds = vi.fn()

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))

// Presence is a bulk ws-do fan-out — mock the helper so the route test stays
// unit-scoped; the set it returns drives each member's `online` boolean.
vi.mock("@/lib/community/member-presence", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/member-presence")>(
    "@/lib/community/member-presence",
  )
  return {
    ...actual,
    fetchOnlineUserIds: (...a: unknown[]) => mockFetchOnlineUserIds(...a),
  }
})

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
        listThreadParticipants: (...a: unknown[]) => mockListThreadParticipants(...a),
        listThreadParticipantUserIds: (...a: unknown[]) => mockListThreadParticipantUserIds(...a),
      },
      communityServer: { getServer: (...a: unknown[]) => mockGetServer(...a) },
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

// Dual-actor: crk_ bearer → bot (folded channelMember), else human.
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const authz = req?.headers?.get?.("Authorization") ?? ""
    const actor = authz.startsWith("Bearer crk_")
      ? { kind: "bot", userId: "bot_1", ownerUserId: "o_1", machineId: "m_1" }
      : { kind: "human", userId: "u1", email: "u@t.com" }
    return handler(req, { env: { DB: {} }, actor, params })
  },
  rejectBot: (actor: { kind: string }) => {
    const { NextResponse } = require("next/server")
    return actor.kind === "bot"
      ? NextResponse.json({ error: "forbidden: not available to bots" }, { status: 403 })
      : null
  },
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

  it("resolves a thread to its PARTICIPANT set (notify dimension)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "admin", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    mockListThreadParticipants.mockResolvedValue([
      { userId: "u1", source: "spoke", userName: "Ann", userImage: null, discriminator: "0001", addedAt: "" },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/channels/t1/members"), { params: { id: "t1" } } as any)
    expect(res.status).toBe(200)
    // A thread reads participants, NOT the access audience.
    expect(mockListThreadParticipants).toHaveBeenCalledWith(expect.anything(), "t1")
    expect(mockResolveScopeMembers).not.toHaveBeenCalled()
    expect(mockGetMembersByUserIds).toHaveBeenCalledWith(expect.anything(), "s1", ["u1"])
  })

  it("forum post reads PARTICIPANTS and badges the post's OWN creator", async () => {
    // Post p1 authored by u2; the forum (anchor) is owned by u1. A public post's
    // panel is its participant set — NOT the whole server / access audience.
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "p1", serverId: "s1", type: "forum_post", parentChannelId: "f1", parentMessageId: null, creatorId: "u2" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: false,
    })
    mockListThreadParticipants.mockResolvedValue([
      { userId: "u2", source: "spoke", userName: "Bob", userImage: null, discriminator: "0002", addedAt: "" },
      { userId: "u1", source: "added", userName: "Ann", userImage: null, discriminator: "0001", addedAt: "" },
    ])
    const res = await GET(new NextRequest("http://localhost/api/community/channels/p1/members"), { params: { id: "p1" } } as any)
    const body = await res.json()
    expect(mockListThreadParticipants).toHaveBeenCalledWith(expect.anything(), "p1")
    expect(mockResolveScopeMembers).not.toHaveBeenCalled()
    // The post creator (u2) is badged — NOT the forum owner (u1).
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
    mockFetchOnlineUserIds.mockResolvedValue(new Set<string>())
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

  it("ALLOWS adding to a private FORUM (it owns its roster like a channel)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "f1", serverId: "s1", type: "forum", parentChannelId: null, parentMessageId: null, creatorId: "u1" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "f1" } } as any)
    expect(res.status).toBe(201)
    expect(mockCreateChannelMember).toHaveBeenCalledWith(expect.anything(), {
      channelId: "f1", userId: "u2", addedBy: "u1",
    })
  })

  it("rejects adding to a forum POST (400): posts take participants, not members", async () => {
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "p1", serverId: "s1", type: "forum_post", parentChannelId: "f1", parentMessageId: null, creatorId: "u1" },
      anchor: { id: "f1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: true, isChannelMember: true, isCreator: true,
    })
    const res = await POST(postReq({ userId: "u2" }), { params: { id: "p1" } } as any)
    expect(res.status).toBe(400)
    // A post inherits its forum's access — no access rows. Add participants via
    // the participants route instead.
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  // ── bot arm (folded `channelMember` verb): ref-in-query → member-scoped 404,
  //    lean ChannelMemberResult. ──

  function botGetReq(ref?: string) {
    const q = ref !== undefined ? `?ref=${encodeURIComponent(ref)}` : ""
    return new NextRequest(`http://localhost/api/community/channels/resolve/members${q}`, {
      method: "GET",
      headers: { Authorization: "Bearer crk_abc" },
    })
  }
  const ctxResolve = { params: { id: "resolve" } } as any

  it("bot: private channel → { visibility: private, members, hasMore:false } (lean handle+role+online+status)", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockResolveChannelAccessContext.mockResolvedValue(managerCtx())
    mockResolveScopeMembers.mockResolvedValue([{ userId: "u1", source: "explicit" }])
    mockGetMembersByUserIds.mockResolvedValue([
      { userId: "u1", userName: "alice", discriminator: "0001", role: "member", statusEmoji: "🎧", statusText: "vibing" },
    ])
    mockFetchOnlineUserIds.mockResolvedValue(new Set(["u1"]))
    const res = await GET(botGetReq("/s/general"), ctxResolve)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      visibility: "private",
      hasMore: false,
      members: [{ handle: "alice#0001", role: "member", online: true, status: { emoji: "🎧", text: "vibing" } }],
    })
    expect(mockResolveTargetForMember).toHaveBeenCalledWith({}, "bot_1", "/s/general", {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    // presence batched over the resolved (bounded) roster — never per-member.
    expect(mockFetchOnlineUserIds).toHaveBeenCalledWith(expect.anything(), ["u1"], "s1")
  })

  it("bot: thread ref → always private on the wire; roster is the thread-participant set", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "t1" })
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "t1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1", creatorId: "u1" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u1" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: false,
    })
    mockListThreadParticipantUserIds.mockResolvedValue(["u1", "u2"])
    mockGetMembersByUserIds.mockResolvedValue([
      { userId: "u1", userName: "alice", discriminator: "0001", role: "owner", statusEmoji: null, statusText: null },
      { userId: "u2", userName: "bob", discriminator: "0002", role: "member", statusEmoji: "🌀", statusText: "running" },
    ])
    mockFetchOnlineUserIds.mockResolvedValue(new Set(["u2"]))
    const res = await GET(botGetReq("/s/general/#12"), ctxResolve)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.visibility).toBe("private")
    expect(body.hasMore).toBe(false)
    expect(body.members).toEqual([
      { handle: "alice#0001", role: "owner", online: false, status: { emoji: null, text: "" } },
      { handle: "bob#0002", role: "member", online: true, status: { emoji: "🌀", text: "running" } },
    ])
    expect(mockListThreadParticipantUserIds).toHaveBeenCalledWith({}, "t1")
  })

  it("bot: public channel → { visibility: public, hint } (no enumeration)", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockResolveChannelAccessContext.mockResolvedValue({
      channel: { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId: "u9" },
      anchor: { id: "c1", serverId: "s1", parentChannelId: null, creatorId: "u9" },
      role: "member", isPrivate: false, isChannelMember: false, isCreator: false,
    })
    mockGetServer.mockResolvedValue({ id: "s1", name: "demo" })
    const res = await GET(botGetReq("/demo/general"), ctxResolve)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.visibility).toBe("public")
    expect(body.hint).toContain("alook server member --server demo")
    expect(mockResolveScopeMembers).not.toHaveBeenCalled()
  })

  it("①-C: bot ref to an UNREACHABLE channel → 404, never enumerates", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "channel not found: general" })
    const res = await GET(botGetReq("/s/general"), ctxResolve)
    expect(res.status).toBe(404)
    expect(mockResolveChannelAccessContext).not.toHaveBeenCalled()
    expect(mockResolveScopeMembers).not.toHaveBeenCalled()
  })

  it("bot: DM ref → 400 (channel-scoped, rejected up front before resolve)", async () => {
    const res = await GET(botGetReq("/.dm/alice#0001"), ctxResolve)
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })

  it("bot: missing ref → 400", async () => {
    const res = await GET(botGetReq(), ctxResolve)
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })

  it("bot POST (add-member) → 403 (no bot verb, capability boundary not 404)", async () => {
    const botPost = new NextRequest("http://localhost/api/community/channels/resolve/members", {
      method: "POST",
      headers: { Authorization: "Bearer crk_abc", "content-type": "application/json" },
      body: JSON.stringify({ userId: "u2" }),
    })
    const res = await POST(botPost, ctxResolve)
    expect(res.status).toBe(403)
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })
})
