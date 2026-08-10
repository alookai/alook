import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetMessage = vi.fn()
const mockUpdateOwnMessageContent = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockGetChannelForMember = vi.fn()
const mockGetChannelType = vi.fn()
const mockGetChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMPeer = vi.fn()
const mockIsBlocked = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListReactionsByMessageIds = vi.fn()
const mockGetMessageByChannelAndSeq = vi.fn()
const mockToAgentMessage = vi.fn()
const mockResolveTargetForMember = vi.fn()
const mockFanOutToChannel = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/community/resolve-ref", () => ({
  resolveTargetForMember: (...a: unknown[]) => mockResolveTargetForMember(...a),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannelType: (...a: unknown[]) => mockGetChannelType(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadChannelByParentMessage(...a),
      },
      communityMessage: {
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessagesByIdsInScope: (...a: unknown[]) => mockGetMessagesByIdsInScope(...a),
        getMessageByChannelAndSeq: (...a: unknown[]) => mockGetMessageByChannelAndSeq(...a),
        updateOwnMessageContent: (...a: unknown[]) => mockUpdateOwnMessageContent(...a),
      },
      communityAgentInbox: {
        toAgentMessage: (...a: unknown[]) => mockToAgentMessage(...a),
      },
      communityAttachment: {
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMPeer: (...a: unknown[]) => mockGetDMPeer(...a),
      },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
      },
    },
  }
})

// Dual-actor: crk_ bearer → bot (folded resolve), else human. Human arm carries
// messageId in the path; bot arm carries ref+seq on the query.
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const authz = req?.headers?.get?.("Authorization") ?? ""
    const actor = authz.startsWith("Bearer crk_")
      ? { kind: "bot", userId: "bot_1", ownerUserId: "o_1", machineId: "m_1" }
      : { kind: "human", userId: "u1", email: "u@t.com" }
    return handler(req, { env: { DB: {} }, actor, params })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET, PATCH } from "./route"

function req() {
  return new NextRequest("http://localhost/api/community/messages/m1", { method: "GET" })
}

describe("GET /api/community/messages/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    mockGetMessagesByIdsInScope.mockResolvedValue([])
    // Default: a normal (non-DM) channel → server-scoped member gate.
    mockGetChannelType.mockResolvedValue("text")
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" })
  })

  it("returns the hydrated payload for a channel message when caller is a server member", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetThreadChannelByParentMessage.mockResolvedValue(null)
    mockListByMessageIds.mockResolvedValue([
      { id: "att_1", messageId: "m1", targetId: "c1", filename: "photo.png", r2Key: "channel/c1/uuid/photo.png", contentType: "image/png", size: 12345 },
    ])
    mockListReactionsByMessageIds.mockResolvedValue([
      { messageId: "m1", emoji: "👍", userId: "u1" },
    ])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("m1")
    expect(body.content).toBe("hello")
    expect(body.authorName).toBe("Alice")
    // Attachments came through the mapper (grouped shape) — url is now the
    // id-addressed render URL (attachments fold), served by the canonical
    // channels/{targetId}/attachments/{attachmentId} door.
    expect(body.attachments).toEqual([
      { kind: "image", name: "photo.png", url: "/api/community/channels/c1/attachments/att_1" },
    ])
    // Reactions came through with `me: true` since userId matches.
    expect(body.reactions).toEqual([
      { emoji: "👍", count: 1, me: true, userIds: ["u1"] },
    ])
    // GET convention: ordinary messages map to type: "chat" now (#12's
    // exhaustive discriminator) — was `undefined` before.
    expect(body.type).toBe("chat")
  })

  it("hydrates reply preview when replyToId is set + target is in the same channel", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "yes",
      type: "default",
      mentionType: null,
      replyToId: "m0",
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMessagesByIdsInScope.mockResolvedValue([
      { id: "m0", authorName: "Bob", content: "question?", channelId: "c1" },
    ])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    const body = await res.json()
    expect(body.replyTo).toEqual({ id: "m0", authorName: "Bob", text: "question?" })
    const [, , scope] = mockGetMessagesByIdsInScope.mock.calls[0]
    expect(scope).toEqual({ channelId: "c1" })
  })

  it("omits reply preview when target is in a different channel (scope guard)", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "yes",
      type: "default",
      mentionType: null,
      replyToId: "m0",
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    // The scoped query never returns a message from a different channel — no
    // application-level `.filter()` involved anymore.
    mockGetMessagesByIdsInScope.mockResolvedValue([])

    const res = await GET(req(), { params: { id: "m1" } } as any)
    const body = await res.json()
    // Target not found in scope — mapper returns the `deleted` sentinel.
    expect(body.replyTo).toEqual({ id: "m0", authorName: "Unknown", text: "", deleted: true })
  })

  it("returns 404 when the message doesn't exist", async () => {
    mockGetMessage.mockResolvedValue(null)
    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(404)
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller isn't a member of the channel's server", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-author",
      authorName: "Alice",
      authorImage: null,
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "c1",
      dmConversationId: null,
    })
    mockGetChannelForMember.mockResolvedValue(null)
    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(403)
  })

  it("returns the payload for a DM message when caller participates", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      content: "hi dm",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "dm-1",
    })
    mockGetChannelType.mockResolvedValue("dm")
    mockGetDM.mockResolvedValue({
      id: "dm-1",
      lastMessageAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    mockGetDMPeer.mockResolvedValue({ otherUserId: "u2" })
    mockIsBlocked.mockResolvedValue(false)

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.content).toBe("hi dm")
    // Never touched the channel-permission path.
    expect(mockGetChannelForMember).not.toHaveBeenCalled()
  })

  it("returns 404 when the caller doesn't participate in the DM (no access-member row)", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u-other",
      authorName: "Someone",
      authorImage: null,
      content: "secret",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-07-03T00:00:00.000Z",
      channelId: "dm-1",
    })
    mockGetChannelType.mockResolvedValue("dm")
    mockGetDM.mockResolvedValue({
      id: "dm-1",
      lastMessageAt: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    })
    // Caller is not a participant → no access-member row → 404 from requireDMAccess.
    mockGetDMPeer.mockResolvedValue(null)

    const res = await GET(req(), { params: { id: "m1" } } as any)
    expect(res.status).toBe(404)
  })

  it("returns 400 when the id param is missing", async () => {
    const res = await GET(req(), { params: {} } as any)
    expect(res.status).toBe(400)
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  // ── bot arm (folded `resolve` verb): ref+seq → member-scoped 404, {message}
  //    agent-shape projection. ──

  function botReq(ref?: string, seq?: string) {
    const q = new URLSearchParams()
    if (ref !== undefined) q.set("ref", ref)
    if (seq !== undefined) q.set("seq", seq)
    return new NextRequest(`http://localhost/api/community/messages/resolve?${q.toString()}`, {
      method: "GET",
      headers: { Authorization: "Bearer crk_abc" },
    })
  }
  const ctxResolve = { params: { id: "resolve" } } as any

  it("bot resolves ref+seq via resolveTargetForMember → {message} agent shape", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" })
    mockGetMessageByChannelAndSeq.mockResolvedValue({ id: "m42", channelId: "c1" })
    mockListByMessageIds.mockResolvedValue([])
    mockToAgentMessage.mockResolvedValue({ seq: "#42", channel: "/s/general", sender: "@a", content: { text: "hi" }, time: "" })
    const res = await GET(botReq("/s/general", "42"), ctxResolve)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: expect.objectContaining({ seq: "#42" }) })
    expect(mockResolveTargetForMember).toHaveBeenCalledWith({}, "bot_1", "/s/general", {
      createDmIfMissing: false,
      createThreadIfMissing: false,
      callerKind: "bot",
    })
    expect(mockGetMessageByChannelAndSeq).toHaveBeenCalledWith({}, { channelId: "c1" }, 42)
  })

  it("①-C: bot ref to an UNREACHABLE channel → 404 (member-scoped resolve, not a 403 leak)", async () => {
    mockResolveTargetForMember.mockResolvedValue({ error: 404, message: "channel not found: general" })
    const res = await GET(botReq("/s/general", "42"), ctxResolve)
    expect(res.status).toBe(404)
    // never reaches the seq lookup or the message hydrate.
    expect(mockGetMessageByChannelAndSeq).not.toHaveBeenCalled()
    expect(mockGetMessage).not.toHaveBeenCalled()
  })

  it("bot ref resolves but seq absent in the channel → 404", async () => {
    mockResolveTargetForMember.mockResolvedValue({ kind: "channel", channelId: "c1" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text" })
    mockGetMessageByChannelAndSeq.mockResolvedValue(null)
    const res = await GET(botReq("/s/general", "999"), ctxResolve)
    expect(res.status).toBe(404)
  })

  it("bot seq 0 → 404 (legacy pre-migration sentinel, never a real message)", async () => {
    const res = await GET(botReq("/s/general", "0"), ctxResolve)
    expect(res.status).toBe(404)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })

  it("bot missing ref → 400", async () => {
    const res = await GET(botReq(undefined, "42"), ctxResolve)
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })

  it("bot non-integer seq → 400", async () => {
    const res = await GET(botReq("/s/general", "abc"), ctxResolve)
    expect(res.status).toBe(400)
    expect(mockResolveTargetForMember).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/community/messages/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelType.mockResolvedValue("text")
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1", authorId: "u1", content: "old" })
    mockUpdateOwnMessageContent.mockResolvedValue({ id: "m1", channelId: "c1", content: "new" })
    mockFanOutToChannel.mockResolvedValue(undefined)
  })

  function editReq(content: unknown, bot = false) {
    return new NextRequest("http://localhost/api/community/messages/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(bot ? { Authorization: "Bearer crk_x" } : {}) },
      body: JSON.stringify({ content }),
    })
  }

  it("updates the author's own content", async () => {
    const res = await PATCH(editReq("new"), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    expect(mockUpdateOwnMessageContent).toHaveBeenCalledWith(expect.anything(), {
      messageId: "m1", authorId: "u1", content: "new",
    })
    expect(mockFanOutToChannel).toHaveBeenCalledWith("c1", {
      type: "community:message.edited", channelId: "c1", messageId: "m1", content: "new", serverId: "s1",
    })
  })

  it("does not let an admin or other member edit someone else's message", async () => {
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "c1", authorId: "u2", content: "old" })
    const res = await PATCH(editReq("hijack"), { params: { id: "m1" } } as any)
    expect(res.status).toBe(403)
    expect(mockUpdateOwnMessageContent).not.toHaveBeenCalled()
  })

  it("resolves a real parent-forum opener to its child and omits parent data for replies", async () => {
    // Production shape: opener m1 belongs to the parent forum c1; the child
    // post row points back to it through parentMessageId.
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum" })
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum", parentChannelId: null })
    mockGetThreadChannelByParentMessage.mockResolvedValue({ id: "post_1", serverId: "s1", type: "thread", parentChannelId: "c1", parentMessageId: "m1" })
    const res = await PATCH(editReq("new"), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    expect(mockGetThreadChannelByParentMessage).toHaveBeenCalledWith(expect.anything(), "c1", "m1")
    expect(mockFanOutToChannel).toHaveBeenCalledWith("c1", {
      type: "community:message.edited",
      channelId: "post_1",
      parentChannelId: "c1",
      serverId: "s1",
      messageId: "m1",
      content: "new",
    })

    mockFanOutToChannel.mockClear()
    mockGetChannel.mockResolvedValue({ id: "post_1", serverId: "s1", type: "thread" })
    mockGetMessage.mockResolvedValue({ id: "reply_1", channelId: "post_1", authorId: "u1", content: "old" })
    mockGetChannelForMember.mockResolvedValue({ id: "post_1", serverId: "s1", type: "thread", parentChannelId: "c1" })
    mockUpdateOwnMessageContent.mockResolvedValue({ id: "reply_1", channelId: "post_1", content: "new" })
    await PATCH(
      new NextRequest("http://localhost/api/community/messages/reply_1", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new" }),
      }),
      { params: { id: "reply_1" } } as any,
    )
    expect(mockFanOutToChannel.mock.calls[0]?.[1]).not.toHaveProperty("parentChannelId")
    expect(mockFanOutToChannel.mock.calls[0]?.[1]).toMatchObject({ serverId: "s1" })
  })

  it("keeps DM edit events free of server identity", async () => {
    mockGetChannel.mockResolvedValue({ id: "dm_1", serverId: "dm-server", type: "dm" })
    mockGetMessage.mockResolvedValue({ id: "m1", channelId: "dm_1", authorId: "u1", content: "old" })
    mockUpdateOwnMessageContent.mockResolvedValue({ id: "m1", channelId: "dm_1", content: "new" })
    mockGetDM.mockResolvedValue({ id: "dm_1", channelId: "dm_1" })
    mockGetDMPeer.mockResolvedValue({ otherUserId: "u2" })

    const res = await PATCH(editReq("new"), { params: { id: "m1" } } as any)
    expect(res.status).toBe(200)
    expect(mockFanOutToChannel).toHaveBeenCalledWith("dm_1", {
      type: "community:message.edited",
      channelId: "dm_1",
      messageId: "m1",
      content: "new",
    })
  })

  it("rejects bot credentials and empty content", async () => {
    expect((await PATCH(editReq("new", true), { params: { id: "m1" } } as any)).status).toBe(401)
    expect((await PATCH(editReq("  "), { params: { id: "m1" } } as any)).status).toBe(400)
  })
})
