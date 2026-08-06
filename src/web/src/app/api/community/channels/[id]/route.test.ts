import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockResolveChannelAccessContext = vi.fn()
const mockGetChannel = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetChannelType = vi.fn()
const mockIsChannelPrivate = vi.fn(() => false)
const mockGetCategory = vi.fn()
const mockUpdateChannel = vi.fn()
const mockDeleteChannel = vi.fn()
const mockGetPrivateChannelAudienceUserIds = vi.fn(() => [] as string[])
const mockFanOutToServerMembers = vi.fn()
const mockFanOutToChannel = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
        isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...a),
        updateChannel: (...a: unknown[]) => mockUpdateChannel(...a),
        deleteChannel: (...a: unknown[]) => mockDeleteChannel(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
      },
      communityCategory: { getCategory: (...a: unknown[]) => mockGetCategory(...a) },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOutToServerMembers(...a),
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
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

import { GET, PATCH, DELETE } from "./route"

const ctx = { params: { id: "c1" } } as any
function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
function delReq() {
  return new NextRequest("http://localhost/api/community/channels/c1", { method: "DELETE" })
}

// Raw `resolveChannelAccessContext` return shape (the route calls the REAL
// `requireChannelAccess`, which derives canManage from this). To model a
// canManage=false caller we make them a non-admin, non-creator member of a
// private channel; canManage=true is either admin, or the private-channel
// creator. `anchorCategoryId` is what the cross-boundary check reads for the
// channel's current privacy class.
function accessCtx(over: Partial<{
  role: string
  canManage: boolean
  isPrivate: boolean
  anchorCategoryId: string | null
  creatorId: string
}> = {}) {
  const {
    role = "member",
    canManage = true,
    isPrivate = false,
    anchorCategoryId = null,
  } = over
  // Derive a context that yields the desired canManage under requireChannelAccess:
  //   canManage = isAdmin || (isPrivate && isCreator)
  const isAdmin = role === "owner" || role === "admin"
  let creatorId = over.creatorId ?? "u1"
  let ctxIsPrivate = isPrivate
  if (!canManage) {
    // non-admin, non-creator, private (so access is member-only, no manage)
    creatorId = "someone_else"
    ctxIsPrivate = true
  } else if (!isAdmin) {
    // canManage via being the private-channel creator
    creatorId = "u1"
    ctxIsPrivate = true
  }
  const channel = { id: "c1", serverId: "s1", type: "text", parentChannelId: null, parentMessageId: null, creatorId, categoryId: anchorCategoryId }
  return {
    channel,
    anchor: { ...channel },
    role,
    isPrivate: ctxIsPrivate,
    isChannelMember: !canManage, // member-only access for the non-manage case
    // Roster-anchor creator gate; caller in these tests is always "u1".
    isCreator: creatorId === "u1",
  }
}

function getReq() {
  return new NextRequest("http://localhost/api/community/channels/c1", { method: "GET" })
}

// GET is the canonical channel-meta reader (folds the old threads/[id] GET —
// the thread-view opener + child-channel bootstrap that page.tsx:473 read).
// Two-step probe: unknown channel → 404, known channel + non-member → 403.
describe("GET /channels/[id] — channel meta", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the channel row when the caller is a member", async () => {
    const channel = { id: "c1", serverId: "s1", type: "thread", parentChannelId: "p1", parentMessageId: "m1", creatorId: "u1" }
    mockGetChannel.mockResolvedValue(channel)
    mockGetChannelForMember.mockResolvedValue(channel)
    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(channel)
  })

  it("returns 400 when the id is missing", async () => {
    const res = await GET(getReq(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetChannel).not.toHaveBeenCalled()
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the channel does not exist (existence-mask 404 before the membership check)", async () => {
    mockGetChannel.mockResolvedValue(null)
    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 403 when the channel exists but the caller is not a member", async () => {
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" })
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await GET(getReq(), { params: { id: "c1" } } as any)
    expect(res.status).toBe(403)
  })
})

describe("PATCH /channels/[id] — permission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateChannel.mockResolvedValue({ id: "c1", name: "renamed" })
    mockIsChannelPrivate.mockResolvedValue(false)
  })

  it("403 when the caller can't see the channel (null context)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null)
    const res = await PATCH(patchReq({ name: "x" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("403 when the caller has access but not canManage", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: false }))
    const res = await PATCH(patchReq({ name: "x" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("manager can rename", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: true }))
    const res = await PATCH(patchReq({ name: "renamed" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateChannel).toHaveBeenCalledWith(expect.anything(), "c1", { name: "renamed" })
  })

  it("normalizes a spaced rename via slugify before calling updateChannel", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: true }))
    mockUpdateChannel.mockResolvedValue({ id: "c1", name: "General-Chat" })
    const res = await PATCH(patchReq({ name: "General Chat" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateChannel).toHaveBeenCalledWith(expect.anything(), "c1", { name: "General-Chat" })
  })

  it("returns 400 (and never calls updateChannel) when the renamed name is all disallowed characters", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: true }))
    const res = await PATCH(patchReq({ name: "   " }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("returns 409 when renaming onto a name already used by another channel in the server", async () => {
    mockUpdateChannel.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed: community_channel.server_id, community_channel.name"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      }),
    )

    const res = await PATCH(patchReq({ name: "general" }), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "a channel with this name already exists" })
  })

  it("rethrows non-uniqueness errors from updateChannel", async () => {
    mockUpdateChannel.mockRejectedValue(new Error("boom"))
    await expect(PATCH(patchReq({ name: "general" }), ctx)).rejects.toThrow("boom")
  })
})

// The post self-delete carve-out: a PUBLIC post (= a thread rooted directly
// under a forum) creator has canManage=false (canManage = isAdmin ||
// (isPrivate && isCreator)), but may still delete THAT post. The carve-out
// keys off (isThread && creatorId===caller && parent is a forum) — NOT
// "any thread's creator" (Aigneis's authz catch: a thread opened incidentally
// by replying in an ordinary channel must NOT grant its opener delete power
// over the whole conversation). Tests here mock `getChannelType` for the
// parent-is-forum lookup.
function forumPostCtx(over: { isCreator?: boolean; type?: string } = {}) {
  const { isCreator = true, type = "thread" } = over
  const channel = {
    id: "c1", serverId: "s1", type, parentChannelId: "forum_1",
    parentMessageId: "m1", creatorId: isCreator ? "u1" : "someone_else", categoryId: null,
  }
  return {
    channel,
    anchor: { ...channel, id: "forum_1", creatorId: "forum_owner" },
    role: "member",
    isPrivate: false, // public post → canManage resolves false even for the creator
    isChannelMember: false,
    isCreator,
  }
}

describe("PATCH /channels/[id] — categoryId move", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateChannel.mockResolvedValue({ id: "c1" })
    mockIsChannelPrivate.mockResolvedValue(false)
  })

  it("403 when a non-admin (but private-channel creator) tries to move it", async () => {
    // canManage true via creator, but role is member → not admin.
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "member", canManage: true, isPrivate: true, anchorCategoryId: "catP" }),
    )
    const res = await PATCH(patchReq({ categoryId: "catP2" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("admin move within the same privacy class (public→public) persists categoryId", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "admin", canManage: true, isPrivate: false, anchorCategoryId: "catA" }),
    )
    // target category is public
    mockGetCategory.mockResolvedValue({ id: "catB", serverId: "s1", private: 0 })
    const res = await PATCH(patchReq({ categoryId: "catB" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateChannel).toHaveBeenCalledWith(expect.anything(), "c1", { categoryId: "catB" })
  })

  it("admin move public→private is blocked with 400", async () => {
    // current channel is public (anchor has no categoryId → currentPrivate=false)
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "admin", canManage: true, isPrivate: false, anchorCategoryId: null }),
    )
    mockGetCategory.mockResolvedValue({ id: "catP", serverId: "s1", private: 1 })
    const res = await PATCH(patchReq({ categoryId: "catP" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("admin move private→public (to uncategorized, categoryId=null) is blocked with 400", async () => {
    // current channel is private (anchor has a categoryId + isChannelPrivate=true)
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "admin", canManage: true, isPrivate: true, anchorCategoryId: "catP" }),
    )
    mockIsChannelPrivate.mockResolvedValue(true) // currentPrivate
    const res = await PATCH(patchReq({ categoryId: null }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })

  it("404 when the target category belongs to another server", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "admin", canManage: true, isPrivate: false, anchorCategoryId: "catA" }),
    )
    mockGetCategory.mockResolvedValue({ id: "catB", serverId: "OTHER", private: 0 })
    const res = await PATCH(patchReq({ categoryId: "catB" }), ctx)
    expect(res.status).toBe(404)
    expect(mockUpdateChannel).not.toHaveBeenCalled()
  })
})

describe("DELETE /channels/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteChannel.mockResolvedValue({ id: "c1" })
    mockIsChannelPrivate.mockResolvedValue(false)
    mockGetChannelType.mockResolvedValue("forum")
  })

  it("403 when not canManage", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: false }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  it("manager deletes a public channel; fans out server-wide", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ role: "admin", canManage: true }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockFanOutToServerMembers).toHaveBeenCalled()
    expect(mockBroadcastToUserSafe).not.toHaveBeenCalled()
  })

  it("private-channel delete fans out to the resolved audience only", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "member", canManage: true, isPrivate: true, anchorCategoryId: "catP" }),
    )
    mockIsChannelPrivate.mockResolvedValue(true)
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1", "u2"])
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockBroadcastToUserSafe).toHaveBeenCalledTimes(2)
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
  })

  it("admin deletes any post (thread under a forum) → 204 and broadcasts", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      accessCtx({ role: "admin", canManage: true, creatorId: "someone_else" }),
    )
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteChannel).toHaveBeenCalled()
    expect(mockFanOutToServerMembers).toHaveBeenCalled()
  })

  it("a PUBLIC post's creator (no canManage) can delete it via the carve-out", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(forumPostCtx({ isCreator: true }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteChannel).toHaveBeenCalledWith(expect.anything(), "c1")
    expect(mockGetChannelType).toHaveBeenCalledWith(expect.anything(), "forum_1")
  })

  it("a private post's creator can delete it (canManage already true)", async () => {
    // Private post creator: canManage = isPrivate && isCreator → true anyway.
    mockResolveChannelAccessContext.mockResolvedValue({
      ...forumPostCtx({ isCreator: true }),
      isPrivate: true,
    })
    mockIsChannelPrivate.mockResolvedValue(true)
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["u1"])
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    expect(mockDeleteChannel).toHaveBeenCalled()
  })

  it("a non-creator non-admin cannot delete a post → 403", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(forumPostCtx({ isCreator: false }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  it("the FORUM creator cannot delete a post they didn't author (isCreator is access-only)", async () => {
    // Regression guard: the delete carve-out keys off the POST's own creator
    // (`channel.creatorId`), not the collapsed access `isCreator` (= forum creator).
    mockResolveChannelAccessContext.mockResolvedValue({
      ...forumPostCtx({ isCreator: false }), // post authored by "someone_else"
      isCreator: true, // caller u1 is the forum/anchor creator (access flag)
    })
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  // SECURITY REGRESSION GUARD (Aigneis's catch): the carve-out must NOT widen
  // to "any thread's creator". A thread opened incidentally by replying in an
  // ordinary text channel is a conversation side-effect, not an intentional
  // "post" — its creator must NOT gain delete power over the whole thread
  // (which would cascade-delete every reply in it) just because they
  // triggered it. Only a thread whose PARENT is a forum carries the
  // deliberate creation semantics the old forum_post carve-out covered.
  it("a thread's creator under a PLAIN CHANNEL (not a forum) cannot delete it via the carve-out → 403", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(forumPostCtx({ isCreator: true }))
    mockGetChannelType.mockResolvedValue("text") // parent is a plain channel, not a forum
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })

  it("the broadcast CHANNEL_DELETE payload carries parentChannelId", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(forumPostCtx({ isCreator: true }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(204)
    const event = mockFanOutToServerMembers.mock.calls[0]?.[1]
    expect(event).toMatchObject({
      type: "community:channel.delete",
      channelId: "c1",
      parentChannelId: "forum_1",
    })
  })

  it("the carve-out does NOT let a non-creator delete a normal (non-thread) channel", async () => {
    // canManage=false + type="text" + not creator → still 403 (carve-out is
    // scoped to threads-under-a-forum only).
    mockResolveChannelAccessContext.mockResolvedValue(accessCtx({ canManage: false }))
    const res = await DELETE(delReq(), ctx)
    expect(res.status).toBe(403)
    expect(mockDeleteChannel).not.toHaveBeenCalled()
  })
})
