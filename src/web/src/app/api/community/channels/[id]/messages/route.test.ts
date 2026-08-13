import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

const mockGetChannelForMember = vi.fn()
const mockGetChannel = vi.fn()
const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessageByAuthorAndNonce = vi.fn()
const mockGetMessageInScope = vi.fn()
const mockGetMessagesByIdsInScope = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockListChildChannels = vi.fn()
const mockIsChannelPrivate = vi.fn(() => false)
const mockGetPrivateChannelAudienceUserIds = vi.fn(() => [] as string[])
const mockListMessages = vi.fn()
const mockListMessagesAround = vi.fn()
const mockListMessagesSince = vi.fn()
const mockGetLatestMessageSeq = vi.fn()
const mockListByMessageIds = vi.fn()
const mockFindPendingAttachmentsForSender = vi.fn()
const mockReserveAttachmentsForMessage = vi.fn()
const mockListReactionsByMessageIds = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetDM = vi.fn()
const mockGetDMPeer = vi.fn()
const mockIsBlocked = vi.fn()
const mockListMessagesBySeq = vi.fn()
const mockToAgentMessages = vi.fn()
const mockToAgentMessage = vi.fn()
const mockGetLatestSeqForScope = vi.fn()
const mockGetReadState = vi.fn()
const mockHasDeliverableUnreadForAgentScope = vi.fn()
const mockBumpBotDailyActivityStatement = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockResolveChannelByNameForMember = vi.fn()
const mockGetUserByNameAndDiscriminator = vi.fn()
const mockGetDMBetween = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetThreadChannelByParentMessage = vi.fn()
const mockDeleteChannel = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockRebindPendingAttachmentsToChild = vi.fn()

const mockFanOutToChannel = vi.fn()
const mockResolveChannelRecipients = vi.fn(async () => [] as string[])
const mockDispatchMessageNotify = vi.fn(async () => {})
const mockBroadcastToUser = vi.fn()
const mockCheckMessageRateLimit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckMessageRateLimit(...a),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: {
        getChannelForMember: (...a: unknown[]) => mockGetChannelForMember(...a),
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        resolveChannelByNameForMember: (...a: unknown[]) => mockResolveChannelByNameForMember(...a),
        listChildChannels: (...a: unknown[]) => mockListChildChannels(...a),
        isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
        createChannel: (...a: unknown[]) => mockCreateChannel(...a),
        getThreadChannelByParentMessage: (...a: unknown[]) => mockGetThreadChannelByParentMessage(...a),
        deleteChannel: (...a: unknown[]) => mockDeleteChannel(...a),
      },
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessageByAuthorAndNonce: (...a: unknown[]) => mockGetMessageByAuthorAndNonce(...a),
        getMessageInScope: (...a: unknown[]) => mockGetMessageInScope(...a),
        getMessagesByIdsInScope: (...a: unknown[]) => mockGetMessagesByIdsInScope(...a),
        listMessages: (...a: unknown[]) => mockListMessages(...a),
        listMessagesAround: (...a: unknown[]) => mockListMessagesAround(...a),
        listMessagesSince: (...a: unknown[]) => mockListMessagesSince(...a),
        getLatestMessageSeq: (...a: unknown[]) => mockGetLatestMessageSeq(...a),
        hardDeleteMessage: (...a: unknown[]) => mockHardDeleteMessage(...a),
        getMessageByAuthorAndNonce: (...a: unknown[]) => mockGetMessageByAuthorAndNonce(...a),
      },
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityMention: {
        createMentions: (...a: unknown[]) => mockCreateMentions(...a),
      },
      communityThread: {
        addThreadParticipants: vi.fn(async () => undefined),
      },
      communityAttachment: {
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
        findPendingAttachmentsForSender: (...a: unknown[]) => mockFindPendingAttachmentsForSender(...a),
        reserveAttachmentsForMessage: (...a: unknown[]) => mockReserveAttachmentsForMessage(...a),
        rebindPendingAttachmentsToChild: (...a: unknown[]) => mockRebindPendingAttachmentsToChild(...a),
      },
      communityReaction: {
        listReactionsByMessageIds: (...a: unknown[]) => mockListReactionsByMessageIds(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
        getUserByNameAndDiscriminator: (...a: unknown[]) => mockGetUserByNameAndDiscriminator(...a),
      },
      // The door's DM arm (requireDMAccess) uses these when a DM id is dispatched.
      communityDm: {
        getDM: (...a: unknown[]) => mockGetDM(...a),
        getDMPeer: (...a: unknown[]) => mockGetDMPeer(...a),
        getDMBetween: (...a: unknown[]) => mockGetDMBetween(...a),
      },
      communityFriendship: {
        isBlocked: (...a: unknown[]) => mockIsBlocked(...a),
      },
      // Bot read arm (GET dual-actor): seq-window + agent-message projection.
      communityAgentInbox: {
        listMessagesBySeq: (...a: unknown[]) => mockListMessagesBySeq(...a),
        toAgentMessages: (...a: unknown[]) => mockToAgentMessages(...a),
        toAgentMessage: (...a: unknown[]) => mockToAgentMessage(...a),
        getLatestSeqForScope: (...a: unknown[]) => mockGetLatestSeqForScope(...a),
        hasDeliverableUnreadForAgentScope: (...a: unknown[]) => mockHasDeliverableUnreadForAgentScope(...a),
      },
      communityReadState: {
        getReadState: (...a: unknown[]) => mockGetReadState(...a),
      },
      communityBot: {
        bumpBotDailyActivityStatement: (...a: unknown[]) => mockBumpBotDailyActivityStatement(...a),
      },
      // resolveTargetForMember (real, for the bot ref-via-query arm) resolves
      // the server then channel by name, both member-scoped.
      communityServer: {
        resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  resolveChannelRecipients: (...a: unknown[]) => mockResolveChannelRecipients(...a),
}))

vi.mock("@/lib/community/notify", () => ({
  dispatchMessageNotify: (...a: unknown[]) => mockDispatchMessageNotify(...a),
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

// POST is now the dual-actor door (withCommunityActor). These POST tests
// exercise the HUMAN arm — mock the wrapper to yield a human actor + the real
// channelId from the path. The bot arm is covered in the send-fold tests.
vi.mock("@/lib/middleware/community-actor", () => ({
  // Credential-based actor dispatch (mirrors the real wrapper): a crk_ bearer →
  // bot actor, else → human. Lets the bot-read arm be exercised via header.
  withCommunityActor: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    const authz = req?.headers?.get?.("Authorization") ?? ""
    const actor = authz.startsWith("Bearer crk_")
      ? { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "m_1" }
      : { kind: "human", userId: "u1", email: "u@t.com" }
    return handler(req, { env: { DB: {} }, actor, params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number, headers?: Record<string, string>) =>
      NextResponse.json({ error: message }, { status, ...(headers ? { headers } : {}) }),
  }
})

import { POST, GET } from "./route"
import { MAX_MESSAGE_CONTENT_LENGTH, MAX_ATTACHMENTS_PER_MESSAGE, MAX_FORUM_TAG_LENGTH, WS_EVENTS } from "@alook/shared"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/c1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function botPostReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/channels/send/messages", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: "Bearer crk_test" },
  })
}

function getReq() {
  return new NextRequest("http://localhost/api/community/channels/c1/messages", { method: "GET" })
}

const ctx = { params: { id: "c1" } } as any

describe("POST /api/community/channels/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
    // The door's single mask (requireMessageSurfaceAccess) probes getChannel
    // first to dispatch by surface; default = the same text channel.
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
    mockCreateMessage.mockResolvedValue({ id: "m1" })
    // Human author by default.
    mockGetUserInternal.mockResolvedValue({ isBot: false, deletedAt: null })
    mockGetMessage.mockResolvedValue({
      id: "m1",
      seq: 12,
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      authorEmail: "u1@t.com",
      content: "hello",
      type: "default",
      mentionType: null,
      replyToId: null,
      channelId: "c1",
      embeds: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })
    mockGetMessageByAuthorAndNonce.mockResolvedValue(null)
    mockListMembers.mockResolvedValue([])
    mockListByMessageIds.mockResolvedValue([])
    mockListMemberUserIds.mockResolvedValue([])
    mockGetMessagesByIdsInScope.mockResolvedValue([])
    mockCreateMentions.mockResolvedValue(undefined)
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockGetLatestSeqForScope.mockResolvedValue(0)
    mockGetReadState.mockResolvedValue(null)
    mockHasDeliverableUnreadForAgentScope.mockResolvedValue(false)
    mockBumpBotDailyActivityStatement.mockReturnValue({})
    mockToAgentMessage.mockImplementation(async (_db, row, _user, attachments) => ({ ...row, attachments }))
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: true })
    mockCreateChannel.mockResolvedValue({ id: "thread_1", creatorId: "u1", createdAt: "t0", name: "thread" })
    mockRebindPendingAttachmentsToChild.mockResolvedValue(true)
  })

  it("accepts a bare message to a forum top-level (phase2 forum≡thread write-guard reversal — forum is now directly sendable)", async () => {
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum", parentChannelId: null })
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum", parentChannelId: null })
    const res = await POST(postReq({ content: "a post's opener message" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCreateMessage).toHaveBeenCalled()
  })

  it("binds validated human attachment ids to the forum opener message", async () => {
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum", parentChannelId: null })
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "forum", parentChannelId: null })
    mockFindPendingAttachmentsForSender.mockResolvedValue([{ id: "att_1" }])
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"])
    mockListByMessageIds.mockResolvedValue([{
      id: "att_1", targetId: "c1", filename: "clip.webm", thumbnailR2Key: null,
      contentType: "video/webm", size: 10, width: null, height: null,
    }])

    const res = await POST(postReq({ content: "Media post", attachments: ["att_1"] }), ctx)

    expect(res.status).toBe(201)
    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledWith({}, {
      ids: ["att_1"], uploaderId: "u1", targetId: "c1",
    })
    expect(mockReserveAttachmentsForMessage).toHaveBeenCalledWith({}, {
      ids: ["att_1"], messageId: "m1",
    })
    expect(mockRebindPendingAttachmentsToChild).toHaveBeenCalledWith({}, expect.objectContaining({ ids: [] }))
  })

  it("a DM id via the door routes to the DM arm — the block gate runs (blocked peer → 403, not a silent channel-route bypass)", async () => {
    // Corrected direction (one door): a DM id is a valid target here, dispatched
    // to requireDMAccess (which runs the block check) — NOT the old two-door
    // "reject DM on channel route with 400". The P0 the old test guarded (block
    // bypass) is now closed by the dm arm running requireDMAccess, proven here:
    // a blocked peer is refused 403, and createCommunityMessage never fires.
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: null, type: "dm", parentChannelId: null })
    mockGetDM.mockResolvedValue({ id: "c1", lastMessageAt: null, createdAt: "t" })
    mockGetDMPeer.mockResolvedValue({ otherUserId: "u2" })
    mockIsBlocked.mockResolvedValue(true)
    const res = await POST(postReq({ content: "sneaking past block" }), ctx)
    expect(res.status).toBe(403)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("returns 429 with Retry-After when the sender is rate limited", async () => {
    mockCheckMessageRateLimit.mockResolvedValue({ allowed: false, retryAfterSec: 7 })

    const res = await POST(postReq({ content: "hello" }), ctx)

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("7")
    expect(mockCreateMessage).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
  })

  it("checks the rate limit for the sender's userId, scoped after channel-membership auth", async () => {
    const res = await POST(postReq({ content: "hello" }), ctx)
    expect(res.status).toBe(201)
    expect(mockCheckMessageRateLimit).toHaveBeenCalledWith(expect.anything(), "community:msgSend", "u1")
    // Membership check must run before rate limiting (auth first).
    expect(mockGetChannelForMember).toHaveBeenCalled()
  })

  it("returns canonical id, seq, and clientNonce for a fresh accepted send", async () => {
    mockGetMessage.mockResolvedValue({
      id: "m1",
      seq: 12,
      clientNonce: "n1",
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

    const res = await POST(postReq({ content: "hello", nonce: "n1" }), ctx)
    const body = await res.json() as { message: { id: string; seq: number; clientNonce?: string }; deduped?: boolean }

    expect(res.status).toBe(201)
    expect(body).toEqual({
      message: expect.objectContaining({ id: "m1", seq: 12, clientNonce: "n1" }),
    })
  })

  it("returns the original canonical contract for a same-nonce replay", async () => {
    mockGetMessageByAuthorAndNonce.mockResolvedValue({
      id: "m-existing",
      seq: 8,
      clientNonce: "n1",
      channelId: "c1",
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

    const res = await POST(postReq({ content: "hello", nonce: "n1" }), ctx)
    const body = await res.json() as { message: { id: string; seq: number; clientNonce?: string }; deduped: boolean }

    expect(res.status).toBe(200)
    expect(body).toEqual({
      message: expect.objectContaining({ id: "m-existing", seq: 8, clientNonce: "n1" }),
      deduped: true,
    })
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("returns the full raw message row for human POST convergence", async () => {
    const row = {
      id: "m_full",
      authorId: "u1",
      authorName: "Canonical Author",
      authorImage: "https://avatar.test/u1.png",
      authorEmail: "u1@t.com",
      content: "canonical content",
      type: "default",
      mentionType: null,
      replyToId: null,
      channelId: "c1",
      embeds: [{ title: "Canonical embed" }],
      seq: 42,
      createdAt: "2026-08-07T10:00:00.000Z",
    }
    mockGetMessage.mockResolvedValue(row)

    const response = await POST(postReq({ content: "canonical content", nonce: "client-1" }), ctx)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ message: row })
  })

  it("rejects content longer than MAX_MESSAGE_CONTENT_LENGTH with 400", async () => {
    const tooLong = "a".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
    const res = await POST(postReq({ content: tooLong }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("rejects more than MAX_ATTACHMENTS_PER_MESSAGE attachments with 400", async () => {
    // Reserve-by-id: the human arm sends pending-row IDS. All ids validate as
    // owned/attachable (findPending echoes them), so the over-cap rejection is
    // the message handler's own MAX_ATTACHMENTS_PER_MESSAGE guard, not a
    // validation miss.
    const attachmentIds = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => `att_${i}`)
    mockFindPendingAttachmentsForSender.mockResolvedValue(attachmentIds.map((id) => ({ id })))
    const res = await POST(postReq({ content: "ok", attachments: attachmentIds }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("reserve-by-id: validates the pending ids (uploader+target) then passes attachmentIds to the handler", async () => {
    mockFindPendingAttachmentsForSender.mockResolvedValue([{ id: "att_1" }, { id: "att_2" }])
    mockCreateMessage.mockResolvedValue({ id: "m_new" })
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1", "att_2"])
    mockListByMessageIds.mockResolvedValue([])
    const res = await POST(postReq({ content: "pics", attachments: ["att_1", "att_2"] }), ctx)
    expect(res.status).toBe(201)
    // The validation query is scoped to THIS user + THIS channel (self-scope /
    // confused-deputy-safe — the human dual of the download authorize-from-row).
    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ids: ["att_1", "att_2"], uploaderId: "u1" }),
    )
  })

  it("reserve-by-id confused-deputy guard: a foreign/stolen pending id (count mismatch) → 400, no message", async () => {
    // The composer sends 2 ids but only 1 is owned by this user in this target
    // (the other belongs to someone else / a different channel). The
    // uploader+target-scoped query returns fewer rows than requested → reject
    // with a generic 400 that never says which id failed, and NO message row is
    // created. This is the send-side confused-deputy guard.
    mockFindPendingAttachmentsForSender.mockResolvedValue([{ id: "att_mine" }])
    const res = await POST(postReq({ content: "steal", attachments: ["att_mine", "att_theirs"] }), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateMessage).not.toHaveBeenCalled()
  })

  it("fans out @everyone mention to every non-author member", async () => {
    // Content has no "@" — everyone/here broadcast should go through the
    // userId-only projection, not the name-projected listMembers path.
    mockListMemberUserIds.mockResolvedValue(["u1", "u2", "u3"])

    const res = await POST(postReq({ content: "hey team", mentionType: "everyone" }), ctx)

    expect(res.status).toBe(201)
    expect(mockListMemberUserIds).toHaveBeenCalledTimes(1)
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledTimes(1)
    const [, payload] = mockCreateMentions.mock.calls[0]
    expect(payload.kind).toBe("mention")
    expect(payload.userIds.sort()).toEqual(["u2", "u3"])

    // MENTION_CREATE pushes now flow through the level-gated notify pipeline
    // (not raw broadcastToUser). The @everyone expansion is handed to it as the
    // mention set — @everyone counts as a mention (Gener #28), author excluded.
    expect(mockDispatchMessageNotify).toHaveBeenCalledTimes(1)
    const notifyArgs = mockDispatchMessageNotify.mock.calls[0]
    const mentionedUserIds = (notifyArgs[4] as { mentionedUserIds: string[] }).mentionedUserIds
    expect([...mentionedUserIds].sort()).toEqual(["u2", "u3"])
  })

  it("resolves @Bob candidate via listMembers (name-projected) when content includes '@'", async () => {
    // Content contains "@" — the single fetch must be listMembers (needs
    // userName), covering both broadcast + candidate branches. listMemberUserIds
    // must not fire so we don't double-query.
    mockListMembers.mockResolvedValue([
      { userId: "u1", userName: "Alice", discriminator: "0001" },
      { userId: "u2", userName: "Bob", discriminator: "0002" },
      { userId: "u3", userName: "Carol", discriminator: "0003" },
    ])
    mockGetMessage.mockResolvedValue({
      id: "m1",
      authorId: "u1",
      authorName: "Alice",
      authorImage: null,
      authorEmail: "u1@t.com",
      content: "hi @Bob#0002",
      type: "default",
      mentionType: null,
      replyToId: null,
      embeds: null,
      createdAt: "2026-06-30T00:00:00.000Z",
    })

    const res = await POST(postReq({ content: "hi @Bob#0002" }), ctx)

    expect(res.status).toBe(201)
    expect(mockListMembers).toHaveBeenCalledTimes(1)
    expect(mockListMemberUserIds).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledTimes(1)
    const [, payload] = mockCreateMentions.mock.calls[0]
    expect(payload.kind).toBe("mention")
    expect(payload.userIds).toEqual(["u2"])
  })

  it("does not query members for a plain channel post with no '@' and no everyone/here", async () => {
    // No "@" in content and no broadcast mentionType — neither member query
    // should fire. This is the short-circuit branch of the split in
    // message-handler.ts.
    const res = await POST(postReq({ content: "just a note" }), ctx)
    expect(res.status).toBe(201)
    expect(mockListMembers).not.toHaveBeenCalled()
    expect(mockListMemberUserIds).not.toHaveBeenCalled()
  })

  it("fans CHILD_CHANNEL_UPDATE to the parent when POSTing to a thread channel", async () => {
    // A channel row with a non-null parentChannelId is a thread. Server-side
    // detection replaced the client-side branch: the client always POSTs to
    // /channels/{id}, and this route must recognize the thread and fan out
    // CHILD_CHANNEL_UPDATE so the parent's thread indicator ticks. Before the
    // consolidation, this fan-out lived only in /threads/{id}/messages, so a
    // fast user could beat the client's meta fetch and silently skip it.
    mockGetChannelForMember.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      type: "thread",
      parentChannelId: "c-parent",
    })
    mockGetChannel.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      parentChannelId: "c-parent",
      messageCount: 7,
      lastMessageAt: "2026-06-30T01:00:00.000Z",
    })

    const res = await POST(postReq({ content: "in-thread" }), ctx)
    expect(res.status).toBe(201)

    const childUpdateCall = mockFanOutToChannel.mock.calls.find(
      (c) => c[1]?.type === WS_EVENTS.CHILD_CHANNEL_UPDATE,
    )
    expect(childUpdateCall).toBeTruthy()
    expect(childUpdateCall![0]).toBe("c-parent")
    expect(childUpdateCall![1].parentChannelId).toBe("c-parent")
    expect(childUpdateCall![1].channelId).toBe("c1")
    expect(childUpdateCall![1].changes.messageCount).toBe(7)
  })

  it("does NOT fan CHILD_CHANNEL_UPDATE for a top-level channel (regression)", async () => {
    // Regression: parentChannelId=null must stay the plain-channel path. Only
    // MESSAGE_CREATE should fan out; CHILD_CHANNEL_UPDATE would misdirect the
    // parent-indicator UI for a channel with no parent.
    mockGetChannelForMember.mockResolvedValue({
      id: "c1",
      serverId: "s1",
      type: "text",
      parentChannelId: null,
    })

    const res = await POST(postReq({ content: "top-level" }), ctx)
    expect(res.status).toBe(201)

    const childUpdateCall = mockFanOutToChannel.mock.calls.find(
      (c) => c[1]?.type === WS_EVENTS.CHILD_CHANNEL_UPDATE,
    )
    expect(childUpdateCall).toBeUndefined()
    // (Under the door, getChannel IS called by the dispatch mask
    // (requireMessageSurfaceAccess) for every send — the old "getChannel only in
    // the thread branch" check no longer holds; the real regression guard is the
    // no-CHILD_CHANNEL_UPDATE assertion above.)
  })

  it("human full-command replay hydrates bound attachments before pending validation", async () => {
    const stored = { id: "a1", targetId: "c1", filename: "x.png", contentType: "image/png", size: 10, width: 1, height: 1 }
    mockFindPendingAttachmentsForSender.mockResolvedValueOnce([stored])
    mockReserveAttachmentsForMessage.mockResolvedValueOnce(["a1"])
    mockListByMessageIds.mockResolvedValue([stored])
    mockGetMessageByAuthorAndNonce
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...await mockGetMessage(), clientNonce: "cmd:reply" })

    const first = await POST(postReq({ content: "reply", attachments: ["a1"], nonce: "cmd:reply" }), ctx)
    const replay = await POST(postReq({ content: "reply", attachments: ["a1"], nonce: "cmd:reply" }), ctx)

    expect(first.status).toBe(201)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(expect.objectContaining({ deduped: true }))
    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledTimes(1)
    expect(mockCreateMessage).toHaveBeenCalledTimes(1)
    expect(mockReserveAttachmentsForMessage).toHaveBeenCalledTimes(1)
  })

  it("bot full-command replay bypasses alignment and pending checks after the first committed send", async () => {
    const stored = { id: "a1", targetId: "c1", filename: "x.png", contentType: "image/png", size: 10, width: 1, height: 1 }
    const row = { ...await mockGetMessage(), authorId: "bot_1", clientNonce: "cmd:reply" }
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "s1" }])
    mockResolveChannelByNameForMember.mockResolvedValue([{ id: "c1", serverId: "s1", type: "text", parentChannelId: null }])
    mockFindPendingAttachmentsForSender.mockResolvedValueOnce([stored])
    mockReserveAttachmentsForMessage.mockResolvedValueOnce(["a1"])
    mockListByMessageIds.mockResolvedValue([stored])
    mockGetMessageByAuthorAndNonce
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row)

    const body = { channel: "/demo#0042/text", content: { text: "reply" }, attachments: ["a1"], nonce: "cmd:reply" }
    const first = await POST(botPostReq(body), ctx)
    const replay = await POST(botPostReq(body), ctx)

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(expect.objectContaining({ state: "sent", deduped: true }))
    expect(mockFindPendingAttachmentsForSender).toHaveBeenCalledTimes(1)
    expect(mockCreateMessage).toHaveBeenCalledTimes(1)
    expect(mockHasDeliverableUnreadForAgentScope).toHaveBeenCalledTimes(1)
  })
})

describe("GET /api/community/channels/[id]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
    // The door's single mask probes getChannel first (dual-actor GET dispatch).
    mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
    mockListChildChannels.mockResolvedValue([])
    mockListByMessageIds.mockResolvedValue([])
    mockListReactionsByMessageIds.mockResolvedValue([])
    // Every route branch calls `getLatestMessageSeq` — default to a small
    // sentinel so each test doesn't have to wire it individually.
    mockGetLatestMessageSeq.mockResolvedValue(0)
  })

  it("resolves reply previews via one scoped getMessagesByIdsInScope call (never per-item getMessage)", async () => {
    // 5-message page. 3 have replyToId set:
    //   m-a → target r-in-scope (same channel) → resolves.
    //   m-b → target r-out-of-scope (a different channel) → the scoped query
    //         never returns it (filtered in SQL, not application code) → deleted.
    //   m-c → target r-missing → deleted.
    //   m-d → replies to r-in-scope again → resolves.
    //   m-e → no reply.
    mockListMessages.mockResolvedValue([
      { id: "m-a", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hey", type: "default", mentionType: null, replyToId: "r-in-scope", channelId: "c1", embeds: null, createdAt: "t1" },
      { id: "m-b", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "leak?", type: "default", mentionType: null, replyToId: "r-out-of-scope", channelId: "c1", embeds: null, createdAt: "t2" },
      { id: "m-c", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "gone", type: "default", mentionType: null, replyToId: "r-missing", channelId: "c1", embeds: null, createdAt: "t3" },
      { id: "m-d", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "again", type: "default", mentionType: null, replyToId: "r-in-scope", channelId: "c1", embeds: null, createdAt: "t4" },
      { id: "m-e", authorId: "u2", authorName: "B", authorEmail: "b@t.com", authorImage: null, content: "no reply", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "t5" },
    ])
    // The (mocked) scoped query only ever returns in-scope rows — "r-out-of-scope"
    // and "r-missing" are absent, simulating the real WHERE-clause scoping.
    mockGetMessagesByIdsInScope.mockResolvedValue([
      { id: "r-in-scope", authorName: "Zed", content: "original", channelId: "c1", dmConversationId: null },
    ])

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; replyTo?: { id: string; authorName: string; text: string; deleted?: boolean } }> }
    const byId = new Map(body.messages.map((m) => [m.id, m]))

    expect(byId.get("m-a")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-b")?.replyTo).toEqual({ id: "r-out-of-scope", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-c")?.replyTo).toEqual({ id: "r-missing", authorName: "Unknown", text: "", deleted: true })
    expect(byId.get("m-d")?.replyTo).toEqual({ id: "r-in-scope", authorName: "Zed", text: "original" })
    expect(byId.get("m-e")?.replyTo).toBeUndefined()

    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockGetMessage).not.toHaveBeenCalled()
    const [, , scope] = mockGetMessagesByIdsInScope.mock.calls[0]
    expect(scope).toEqual({ channelId: "c1" })
  })

  it("retries BUSY reply enrichment and preserves the paginated response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    mockListMessages.mockResolvedValue([
      { id: "m1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "reply", type: "default", mentionType: null, replyToId: "r1", channelId: "c1", embeds: null, createdAt: "t1" },
    ])
    mockGetMessagesByIdsInScope
      .mockRejectedValueOnce(new Error("D1_ERROR: database is locked"))
      .mockResolvedValueOnce([{ id: "r1", authorName: "B", content: "root", channelId: "c1", dmConversationId: null }])
    const res = await GET(getReq(), ctx)
    const body = await res.json()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].replyTo).toEqual({ id: "r1", authorName: "B", text: "root" })
    expect(body.hasMore).toBe(false)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(2)
    expect(mockListMessages).toHaveBeenCalledTimes(1)
  })

  it("rethrows a non-BUSY reply-enrichment failure without retrying", async () => {
    const error = new Error("bad projection")
    mockListMessages.mockResolvedValue([
      { id: "m1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "reply", type: "default", mentionType: null, replyToId: "r1", channelId: "c1", embeds: null, createdAt: "t1" },
    ])
    mockGetMessagesByIdsInScope.mockRejectedValueOnce(error)
    await expect(GET(getReq(), ctx)).rejects.toBe(error)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
  })

  it("returns author.name verbatim — no 'Unknown' sentinel, no email leak", async () => {
    // Post-migration 0050 the shared query returns user.name as a non-empty
    // string. The route must drop the pre-migration cascade
    // (`authorName ?? authorEmail ?? "Unknown"`) and pass the name through.
    mockListMessages.mockResolvedValue([
      {
        id: "m-1",
        authorId: "u1",
        authorName: "Alice",
        authorEmail: "alice@example.com",
        authorImage: null,
        content: "hey",
        type: "default",
        mentionType: null,
        replyToId: null,
        channelId: "c1",
        embeds: null,
        createdAt: "t1",
      },
    ])
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: Array<{ authorName: string; authorAvatar: string }>
    }
    expect(body.messages[0]?.authorName).toBe("Alice")
    expect(body.messages[0]?.authorName).not.toBe("Unknown")
    expect(body.messages[0]?.authorName).not.toContain("@")
    expect(body.messages[0]?.authorAvatar).toBe("A")
  })

  it("runs attachment, reaction, reply-target, child-channel, and latest-seq fetches in parallel", async () => {
    // The 5 follow-up fetches have no cross-dependency; they must run
    // concurrently (Promise.all), not sequentially. We prove concurrency by
    // observing the in-flight count of the mocked queries.
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "hi", type: "default", mentionType: null, replyToId: "r-1", channelId: "c1", embeds: null, createdAt: "t1" },
    ])

    let inFlight = 0
    let maxInFlight = 0
    async function tracked<T>(value: T): Promise<T> {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight--
      return value
    }
    mockListByMessageIds.mockImplementation(() => tracked([]))
    mockListReactionsByMessageIds.mockImplementation(() => tracked([]))
    mockGetMessagesByIdsInScope.mockImplementation(() => tracked([]))
    mockListChildChannels.mockImplementation(() => tracked([]))
    mockGetLatestMessageSeq.mockImplementation(() => tracked(0))

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)

    // All 5 fetches must have been kicked off before any resolves.
    expect(maxInFlight).toBe(5)
    expect(mockListByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockListReactionsByMessageIds).toHaveBeenCalledTimes(1)
    expect(mockGetMessagesByIdsInScope).toHaveBeenCalledTimes(1)
    expect(mockListChildChannels).toHaveBeenCalledTimes(1)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledTimes(1)
  })

  it("passes parsed embeds through to the response body verbatim", async () => {
    // listMessages already parses embeds at the query layer — the route just
    // forwards. Rows returning `undefined` render as absent embeds; rows with
    // a parsed array render as-is (no double-parse, no re-stringify).
    const parsed = [{ url: "https://x/y", title: "hi" }]
    mockListMessages.mockResolvedValue([
      { id: "m-1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "with embed", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: parsed, createdAt: "t1" },
      { id: "m-2", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "no embed", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: undefined, createdAt: "t2" },
    ])
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string; embeds?: unknown }> }
    const byId = new Map(body.messages.map((m) => [m.id, m]))
    expect(byId.get("m-1")?.embeds).toEqual(parsed)
    expect(byId.get("m-2")?.embeds).toBeUndefined()
  })

  it("always includes latestSeq in the legacy-mode envelope", async () => {
    // The client (A2) reads latestSeq unconditionally — it must be present in
    // every mode's envelope, including the legacy path.
    mockListMessages.mockResolvedValue([])
    mockGetLatestMessageSeq.mockResolvedValue(17)
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { latestSeq: number }
    expect(body.latestSeq).toBe(17)
    expect(mockGetLatestMessageSeq).toHaveBeenCalledWith(expect.anything(), { channelId: "c1" })
  })

  it("passes a normalized tag into the channel-scoped message query before pagination", async () => {
    mockListMessages.mockResolvedValue([])
    const req = new NextRequest("http://localhost/api/community/channels/c1/messages?tag=%20Bug%20&cursor=2026-01-01T00%3A00%3A00.000Z%7Cm1", { method: "GET" })
    const res = await GET(req, ctx)
    expect(res.status).toBe(200)
    expect(mockListMessages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      channelId: "c1",
      tag: "bug",
      cursor: { createdAt: "2026-01-01T00:00:00.000Z", id: "m1" },
    }))
  })

  it.each(["", "   "])("rejects an explicitly empty tag %j instead of widening to all messages", async (tag) => {
    const req = new NextRequest(`http://localhost/api/community/channels/c1/messages?tag=${encodeURIComponent(tag)}`, { method: "GET" })
    const res = await GET(req, ctx)
    expect(res.status).toBe(400)
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  it("rejects a tag longer than the public message-tag limit", async () => {
    const tag = "x".repeat(MAX_FORUM_TAG_LENGTH + 1)
    const req = new NextRequest(`http://localhost/api/community/channels/c1/messages?tag=${tag}`, { method: "GET" })
    const res = await GET(req, ctx)
    expect(res.status).toBe(400)
    expect(mockListMessages).not.toHaveBeenCalled()
  })

  describe("?anchor mode", () => {
    it("returns a centered window with the anchor row present, plus latestSeq + cursors", async () => {
      mockGetMessageInScope.mockResolvedValue({
        id: "m_anchor",
        createdAt: "2026-06-30T00:00:03.000Z",
      })
      mockListMessagesAround.mockResolvedValue({
        older: [
          { id: "m_o1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "o1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:02.000Z" },
        ],
        newer: [
          { id: "m_anchor", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "anchor", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:03.000Z" },
          { id: "m_n1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "n1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:04.000Z" },
        ],
        hasMoreOlder: true,
        hasMoreNewer: false,
      })
      mockGetLatestMessageSeq.mockResolvedValue(9)

      const url = "http://localhost/api/community/channels/c1/messages?anchor=m_anchor"
      const req = new NextRequest(url, { method: "GET" })
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        messages: Array<{ id: string }>
        hasMoreOlder: boolean
        hasMoreNewer: boolean
        olderCursor?: string
        newerCursor?: string
        latestSeq: number
      }
      // Order is chronological ASC: older-reversed then newer.
      expect(body.messages.map((m) => m.id)).toEqual(["m_o1", "m_anchor", "m_n1"])
      expect(body.hasMoreOlder).toBe(true)
      expect(body.hasMoreNewer).toBe(false)
      // olderCursor points at the oldest returned row; newerCursor only when hasMoreNewer.
      expect(body.olderCursor).toBe(`2026-06-30T00:00:02.000Z|m_o1`)
      expect(body.newerCursor).toBeUndefined()
      expect(body.latestSeq).toBe(9)
      // Scope-first resolve: anchor lookup passes the channel scope.
      expect(mockGetMessageInScope).toHaveBeenCalledWith(expect.anything(), "m_anchor", { channelId: "c1" })
    })

    it("returns 404 when the anchor is not visible in this channel", async () => {
      mockGetMessageInScope.mockResolvedValue(null)
      const req = new NextRequest("http://localhost/api/community/channels/c1/messages?anchor=m_missing", {
        method: "GET",
      })
      const res = await GET(req, ctx)
      expect(res.status).toBe(404)
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })

    it("applies tag to the same channel-scoped anchor window", async () => {
      mockGetMessageInScope.mockResolvedValue({ id: "m_anchor", createdAt: "2026-06-30T00:00:03.000Z" })
      mockListMessagesAround.mockResolvedValue({ older: [], newer: [], hasMoreOlder: false, hasMoreNewer: false })
      const req = new NextRequest("http://localhost/api/community/channels/c1/messages?anchor=m_anchor&tag=%20Bug%20", { method: "GET" })
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      expect(mockListMessagesAround).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        channelId: "c1",
        anchor: { createdAt: "2026-06-30T00:00:03.000Z", id: "m_anchor" },
        tag: "bug",
      }))
    })
  })

  describe("?since mode", () => {
    it("returns rows strictly newer than the cursor with hasMoreNewer + newerCursor + latestSeq", async () => {
      mockListMessagesSince.mockResolvedValue([
        { id: "m_1", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "1", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:01.000Z" },
        { id: "m_2", authorId: "u1", authorName: "A", authorEmail: "a@t.com", authorImage: null, content: "2", type: "default", mentionType: null, replyToId: null, channelId: "c1", embeds: null, createdAt: "2026-06-30T00:00:02.000Z" },
      ])
      mockGetLatestMessageSeq.mockResolvedValue(2)

      const req = new NextRequest(
        "http://localhost/api/community/channels/c1/messages?since=2026-06-30T00:00:00.000Z%7Cm_0",
        { method: "GET" },
      )
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        messages: Array<{ id: string }>
        hasMoreNewer: boolean
        newerCursor?: string
        hasMoreOlder: boolean
        olderCursor?: string
        latestSeq: number
      }
      expect(body.messages.map((m) => m.id)).toEqual(["m_1", "m_2"])
      expect(body.hasMoreNewer).toBe(false)
      expect(body.latestSeq).toBe(2)
      // A since delta must carry an older-side signal so it can be paged back
      // through if it lands as the sole/oldest cache page (the DM-history bug).
      expect(body.hasMoreOlder).toBe(true)
      expect(body.olderCursor).toBe("2026-06-30T00:00:01.000Z|m_1")
      // Anchor-mode paths must not fire.
      expect(mockGetMessageInScope).not.toHaveBeenCalled()
      expect(mockListMessagesAround).not.toHaveBeenCalled()
    })

    it("applies tag to the same channel-scoped since delta", async () => {
      mockListMessagesSince.mockResolvedValue([])
      const req = new NextRequest(
        "http://localhost/api/community/channels/c1/messages?since=2026-06-30T00:00:00.000Z%7Cm_0&tag=%20Bug%20",
        { method: "GET" },
      )
      const res = await GET(req, ctx)
      expect(res.status).toBe(200)
      expect(mockListMessagesSince).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        channelId: "c1",
        since: { createdAt: "2026-06-30T00:00:00.000Z", id: "m_0" },
        tag: "bug",
      }))
    })
  })

  describe("bot arm (GET/read convergence — seq window + {items}, ref-via-query, no create)", () => {
    function botGetReq(query = "") {
      return new NextRequest(`http://localhost/api/community/channels/resolve/messages${query}`, {
        method: "GET",
        headers: { Authorization: "Bearer crk_abc" },
      })
    }
    const botCtx = { params: { id: "resolve" } } as any

    it("bot reads via ?ref= → seq window → {items} (agent-message projection), NOT {messages}", async () => {
      // ref resolves to a channel; the door's single mask passes it (bot scope),
      // then the bot arm pages by seq and projects to agent-message {items}.
      // ref /studio#0042/general resolves server→channel (both member-scoped), then
      // the door's mask probes getChannel.
      mockResolveServerByNameForMember.mockResolvedValue([{ id: "s1" }])
      mockResolveChannelByNameForMember.mockResolvedValue([{ id: "c1" }])
      mockGetChannel.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
      mockGetChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1", type: "text", parentChannelId: null })
      mockListMessagesBySeq.mockResolvedValue({ items: [{ id: "m1", seq: 1 }], hasMore: false, latestSeq: 1 })
      mockToAgentMessages.mockResolvedValue([{ seq: 1, text: "hi" }])

      const res = await GET(botGetReq("?ref=%2Fstudio%230042%2Fgeneral&after=0"), botCtx)
      expect(res.status).toBe(200)
      const body = await res.json() as { items?: unknown[]; messages?: unknown[] }
      expect(body.items).toEqual([{ seq: 1, text: "hi" }])
      expect(body.messages).toBeUndefined() // bot arm = {items}, never {messages}
      // Read went through the shared seq query, scoped to the resolved channel.
      expect(mockListMessagesBySeq).toHaveBeenCalledWith({}, { channelId: "c1" }, expect.objectContaining({ after: 0 }))
    })

    it("decodes an encoded ref carrying / and # (DM handle round-trip: %2F.dm%2Fgusye%231231 → /.dm/gusye#1231)", async () => {
      // Gener #263 / Melly #264: a DM ref has `/` AND `#` (fragment char) — the
      // CLI encodeURIComponent's it into the query; NextRequest.searchParams.get
      // auto-decodes, so resolveTargetForMember sees the real ref. This asserts
      // the door gets the DECODED ref (not truncated at #, not left percent-escaped).
      const peer = { id: "peer_1", discriminator: "1231" }
      mockGetUserByNameAndDiscriminator.mockResolvedValue(peer)
      mockGetDMBetween.mockResolvedValue({ id: "dm1" })
      mockGetChannel.mockResolvedValue({ id: "dm1", serverId: null, type: "dm", parentChannelId: null })
      mockGetDM.mockResolvedValue({ id: "dm1", lastMessageAt: null, createdAt: "t" })
      mockGetDMPeer.mockResolvedValue({ otherUserId: "peer_1" })
      mockIsBlocked.mockResolvedValue(false)
      mockListMessagesBySeq.mockResolvedValue({ items: [{ id: "m1", seq: 1 }], hasMore: false, latestSeq: 1 })
      mockToAgentMessages.mockResolvedValue([{ seq: 1, text: "dm hi" }])

      const encoded = encodeURIComponent("/.dm/gusye#1231")
      const res = await GET(botGetReq(`?ref=${encoded}`), botCtx)
      expect(res.status).toBe(200)
      // The DM handle's #1231 was NOT lost as a URL fragment — the peer lookup
      // received the decoded name#disc, proving the round-trip.
      expect(mockGetUserByNameAndDiscriminator).toHaveBeenCalledWith({}, "gusye", "1231")
      const body = await res.json() as { items?: unknown[] }
      expect(body.items).toEqual([{ seq: 1, text: "dm hi" }])
    })

    it("loudly rejects read hydration for an orphan DM without leaking raw ids", async () => {
      mockGetUserByNameAndDiscriminator.mockResolvedValue({ id: "peer_internal", discriminator: "1231" })
      mockGetDMBetween.mockResolvedValue({ id: "dm_internal" })
      mockGetChannel.mockResolvedValue({ id: "dm_internal", serverId: null, type: "dm", parentChannelId: null })
      mockGetDM.mockResolvedValue({ id: "dm_internal", lastMessageAt: null, createdAt: "t" })
      mockGetDMPeer.mockResolvedValue({ otherUserId: "peer_internal" })
      mockIsBlocked.mockResolvedValue(false)
      mockListMessagesBySeq.mockResolvedValue({ items: [{ id: "message_internal", seq: 1 }], hasMore: false, latestSeq: 1 })
      mockToAgentMessages.mockRejectedValue(new Error("DM peer identity unavailable"))

      const read = GET(botGetReq(`?ref=${encodeURIComponent("/.dm/gusye#1231")}`), botCtx)
      await expect(read).rejects.toThrow("DM peer identity unavailable")
      await expect(read).rejects.not.toThrow(/peer_internal|dm_internal|message_internal/)
    })

    it("bot read of a ref to a nonexistent target → 404, NO create (read-create=false ⑤)", async () => {
      // resolveTargetForMember (real, through the mocked queries) returns
      // not-found for an unknown ref; the door surfaces 404 and never creates.
      mockResolveServerByNameForMember.mockResolvedValue([]) // server not found → resolve 404
      const res = await GET(botGetReq("?ref=%2Fnope%230042%2Fmissing"), botCtx)
      expect(res.status).toBe(404)
      // No create query fired — read is pure addressing (structurally the GET
      // descriptor carries no create-if-missing).
      expect(mockCreateMessage).not.toHaveBeenCalled()
    })
  })
})
