import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessageByAuthorAndNonce = vi.fn()
const mockGetMessageInScope = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockGetUserInternal = vi.fn()
const mockReserveAttachmentsForMessage = vi.fn()
const mockUnreserveAttachments = vi.fn()
const mockListByMessageIds = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockGetChannel = vi.fn()
const mockIsChannelPrivate = vi.fn(() => false)
const mockGetPrivateChannelAudienceUserIds = vi.fn(() => [] as string[])
const mockCreateChannelMember = vi.fn()
const mockAddThreadParticipants = vi.fn()

const mockLogError = vi.fn()
const mockLogWarn = vi.fn()
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: (...a: unknown[]) => mockLogWarn(...a),
      debug: vi.fn(),
      error: (...a: unknown[]) => mockLogError(...a),
    }),
    queries: {
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessageByAuthorAndNonce: (...a: unknown[]) => mockGetMessageByAuthorAndNonce(...a),
        getMessageInScope: (...a: unknown[]) => mockGetMessageInScope(...a),
        hardDeleteMessage: (...a: unknown[]) => mockHardDeleteMessage(...a),
      },
      communityAttachment: {
        reserveAttachmentsForMessage: (...a: unknown[]) => mockReserveAttachmentsForMessage(...a),
        unreserveAttachments: (...a: unknown[]) => mockUnreserveAttachments(...a),
        listByMessageIds: (...a: unknown[]) => mockListByMessageIds(...a),
      },
      communityMember: {
        listMembers: (...a: unknown[]) => mockListMembers(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityMention: {
        createMentions: (...a: unknown[]) => mockCreateMentions(...a),
      },
      communityChannel: {
        getChannel: (...a: unknown[]) => mockGetChannel(...a),
        isChannelPrivate: (...a: unknown[]) => mockIsChannelPrivate(...a),
        getPrivateChannelAudienceUserIds: (...a: unknown[]) => mockGetPrivateChannelAudienceUserIds(...a),
        createChannelMember: (...a: unknown[]) => mockCreateChannelMember(...a),
      },
      communityThread: {
        addThreadParticipants: (...a: unknown[]) => mockAddThreadParticipants(...a),
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
    },
  }
})

const mockDispatchCommittedMessage = vi.fn(async () => {})
vi.mock("./message-dispatcher", () => ({
  dispatchCommittedMessage: (...a: unknown[]) => mockDispatchCommittedMessage(...a),
}))

const mockBroadcastToUserSafe = vi.fn(async () => {})
vi.mock("./fanout", () => ({
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))


import {
  createCommunityMessage,
  getCommunityMessageReplay,
  isDmTarget,
  isThreadTarget,
  isChannelTarget,
  type MessageTarget,
} from "./message-handler"

describe("message-target predicates", () => {
  const channel: MessageTarget = { kind: "channel", channelId: "c1", serverId: "s1" }
  const thread: MessageTarget = { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "s1" }
  const dm: MessageTarget = { kind: "dm", channelId: "d1", otherUserId: "u1" }

  it("isChannelTarget", () => {
    expect(isChannelTarget(channel)).toBe(true)
    expect(isChannelTarget(thread)).toBe(false)
    expect(isChannelTarget(dm)).toBe(false)
  })
  it("isThreadTarget", () => {
    expect(isThreadTarget(thread)).toBe(true)
    expect(isThreadTarget(channel)).toBe(false)
    expect(isThreadTarget(dm)).toBe(false)
  })
  it("isDmTarget", () => {
    expect(isDmTarget(dm)).toBe(true)
    expect(isDmTarget(channel)).toBe(false)
    expect(isDmTarget(thread)).toBe(false)
  })
})

function messageRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "msg_1",
    authorId: "author_1",
    content: "hello",
    type: "default",
    mentionType: null,
    replyToId: null,
    embeds: null,
    flags: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    channelId: "c1",
    dmConversationId: null,
    seq: 7,
    authorName: "Author",
    authorEmail: "a@x.com",
    authorImage: null,
    ...overrides,
  }
}

describe("createCommunityMessage — replyToId write-path scope validation (dangling-reply / #204 bot=user)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })
  })

  // The reply target the client asked to answer, living in the SAME channel.
  const inScopeReply = {
    id: "reply_1",
    authorId: "author_2",
    authorName: "Other",
    content: "the parent",
    channelId: "c1",
  }

  it("in-scope replyToId: persists it, and resolves the target with a SINGLE getMessageInScope lookup (no re-query for the preview)", async () => {
    mockGetMessageInScope.mockResolvedValue(inScopeReply)
    mockGetMessage.mockResolvedValue(messageRow({ replyToId: "reply_1" }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "answering", replyToId: "reply_1" },
    })

    expect(result.ok).toBe(true)
    // replyToId reaches the insert unchanged.
    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ replyToId: "reply_1" }),
    )
    // The write-path validation replaces the preview's fetch — not one each.
    expect(mockGetMessageInScope).toHaveBeenCalledTimes(1)
    expect(mockGetMessageInScope).toHaveBeenCalledWith({}, "reply_1", { channelId: "c1" })
    expect(mockLogWarn).not.toHaveBeenCalled()
  })

  it("out-of-scope replyToId: DROPPED (message stored with replyToId undefined), warn-logged, NOT rejected", async () => {
    // Target message isn't in this channel's scope → getMessageInScope returns null.
    mockGetMessageInScope.mockResolvedValue(null)
    mockGetMessage.mockResolvedValue(messageRow({ replyToId: null }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "answering across channels", replyToId: "reply_in_other_channel" },
    })

    // Lenient: the send SUCCEEDS, just as a plain message.
    expect(result.ok).toBe(true)
    // The dangling id never reaches the DB — insert carries undefined.
    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ replyToId: undefined }),
    )
    // Flagged as a likely client bug.
    expect(mockLogWarn).toHaveBeenCalledWith(
      "reply_to_out_of_scope_dropped",
      expect.objectContaining({
        authorId: "author_1",
        channelId: "c1",
        replyToId: "reply_in_other_channel",
      }),
    )
  })

  it("private source channel the author can't see is indistinguishable from missing (getMessageInScope null → same drop, no leak)", async () => {
    // getMessageInScope is `WHERE id=? AND channelId=?`; a private channel the
    // author isn't in resolves to null exactly like a nonexistent id — the
    // handler can't and doesn't branch on which, so neither content nor the
    // channel's existence leaks.
    mockGetMessageInScope.mockResolvedValue(null)
    mockGetMessage.mockResolvedValue(messageRow({ replyToId: null }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "peeking", replyToId: "msg_in_private_channel" },
    })

    expect(result.ok).toBe(true)
    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ replyToId: undefined }),
    )
  })

  it("bot author (source cli) hits the SAME drop — the send codepath is shared, so bots can't POST a dangling reply either (#204)", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })
    mockGetMessageInScope.mockResolvedValue(null)
    mockGetMessage.mockResolvedValue(messageRow({ replyToId: null }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "bot cross-scope reply", replyToId: "reply_elsewhere" },
      source: "cli",
    })

    expect(result.ok).toBe(true)
    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ replyToId: undefined }),
    )
    expect(mockLogWarn).toHaveBeenCalledWith(
      "reply_to_out_of_scope_dropped",
      expect.objectContaining({ source: "cli", replyToId: "reply_elsewhere" }),
    )
  })

  it("no replyToId: no scope lookup at all (unchanged fast path)", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ replyToId: null }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "no reply here" },
    })

    expect(mockGetMessageInScope).not.toHaveBeenCalled()
  })
})

describe("createCommunityMessage — CAS race (plans/fix-agent-send-race-condition.md)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("expectedSeq mismatch (createMessage returns null) → { ok: false, status: 409, error: 'seq_conflict' }, no side effects", async () => {
    mockCreateMessage.mockResolvedValue(null)

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
      source: "cli",
      expectedSeq: 19,
    })

    expect(result).toEqual({ ok: false, status: 409, error: "seq_conflict" })
    // Lost the race — none of the downstream pipeline steps should fire.
    expect(mockGetMessage).not.toHaveBeenCalled()
    expect(mockCreateMentions).not.toHaveBeenCalled()
    expect(mockDispatchCommittedMessage).not.toHaveBeenCalled()
  })

  it("passes expectedSeq through to createMessage when provided", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetMessage.mockResolvedValue(messageRow())
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
      source: "cli",
      expectedSeq: 19,
    })

    expect(mockCreateMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ expectedSeq: 19 }),
    )
  })

  it("omits expectedSeq entirely from the createMessage call when not provided (regression — web/human sends unaffected)", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetMessage.mockResolvedValue(messageRow())
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
    })

    const callArgs = mockCreateMessage.mock.calls[0]![1]
    expect("expectedSeq" in callArgs).toBe(false)
  })
})

describe("createCommunityMessage — committed delivery handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })
  })

  it("returns reserved attachment dimensions but hands only committed identity to the dispatcher", async () => {
    // Reserve-by-id (route/disc step 2b): dimensions are written onto the
    // pending row at UPLOAD (single source) and reach the broadcast when the
    // reserved rows are re-read via listByMessageIds after the reserve. There is
    // no url-carried body path anymore — the caller passes attachmentIds.
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"])
    mockListByMessageIds.mockResolvedValue([
      {
        id: "att_1",
        messageId: "msg_1",
        targetId: "c1",
        filename: "photo.png",
        r2Key: "channel/c1/uuid/photo.png",
        thumbnailR2Key: "channel/c1/uuid/photo.png.thumbnail.jpg",
        contentType: "image/png",
        size: 1000,
        width: 1920,
        height: 1080,
        position: 0,
      },
    ])
    mockGetMessage.mockResolvedValue(messageRow())

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
      attachmentIds: ["att_1"],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attachments).toEqual([
      expect.objectContaining({
        width: 1920,
        height: 1080,
        thumbnailUrl: "/api/community/channels/c1/attachments/att_1/thumbnail",
      }),
    ])
    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {})
  })

  it("does not pass server, parent, audience, or policy through the handler", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetMessage.mockResolvedValue(messageRow())

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: {
        kind: "thread",
        channelId: "post_1",
        serverId: "srv_1",
        parentChannelId: "forum_1",
      },
      body: { content: "reply" },
    })

    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {})
  })

  it("broadcasts the human author watermark as one bounded revision hint", async () => {
    mockCreateMessage.mockResolvedValue({
      id: "msg_1",
      readStateRevision: 12,
    })
    mockGetMessage.mockResolvedValue(messageRow())

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      authorKind: "human",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "human send" },
    })

    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      authorId: "author_1",
      authorKind: "human",
    }))
    await vi.waitFor(() => expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("author_1", {
      type: "community:read_state.advanced",
      revision: 12,
      inboxChanged: true,
    }))
  })

  it("routes a human forum opener through the ordinary author read-state ownership", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_forum", readStateRevision: 13 })
    mockGetMessage.mockResolvedValue(messageRow({ id: "msg_forum", channelId: "forum_1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      authorKind: "human",
      target: { kind: "forum", channelId: "forum_1", serverId: "srv_1" },
      body: { content: "new forum opener" },
    })

    expect(mockCreateMessage).toHaveBeenCalledWith({}, expect.objectContaining({
      authorId: "author_1",
      authorKind: "human",
      channelId: "forum_1",
    }))
  })
})

describe("createCommunityMessage — @Name#0042 mention disambiguation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })
    mockListMembers.mockResolvedValue([
      { userId: "author_1", userName: "Author", discriminator: "1111" },
      { userId: "alex_1", userName: "Alex", discriminator: "0001" },
      { userId: "alex_2", userName: "Alex", discriminator: "0002" },
    ])
  })

  it("disambiguates two same-named members via the @Name#0042 handle in the message body", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Alex#0002, over here" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Alex#0002, over here" },
    })

    expect(mockListMembers).toHaveBeenCalledWith({}, "srv_1")
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["alex_2"],
      kind: "mention",
    })
  })

  it("passes each member's discriminator through as a mention candidate", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Alex#0001" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Alex#0001" },
    })

    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["alex_1"],
      kind: "mention",
    })
  })
})

describe("createCommunityMessage — private-channel mention scoping (no auto-add)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })
    mockListMembers.mockResolvedValue([
      { userId: "author_1", userName: "Author", discriminator: "1111" },
      { userId: "bob_1", userName: "Bob", discriminator: "0001" },
      { userId: "cara_1", userName: "Cara", discriminator: "0002" },
    ])
    mockIsChannelPrivate.mockResolvedValue(true)
    // Audience = author + Cara. Bob is a server member but NOT in the channel.
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
  })

  it("drops an @mention of a non-member: no auto-add, no CHANNEL_MEMBER_ADD, no mention row", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Bob" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Bob" },
    })

    // Channel roster is NOT expanded by a mention.
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
    // Bob was outside the audience → dropped → no mention row.
    expect(mockCreateMentions).not.toHaveBeenCalled()
  })

  it("keeps an @mention of an existing channel member", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Cara#0002" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Cara#0002" },
    })

    expect(mockCreateChannelMember).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["cara_1"],
      kind: "mention",
    })
  })

  it("@everyone is clamped to the audience (author excluded → only Cara)", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "@everyone hi", mentionType: "everyone" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "@everyone hi", mentionType: "everyone" },
    })

    expect(mockCreateChannelMember).not.toHaveBeenCalled()
    // Bob (non-member) not notified; only the in-audience Cara.
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["cara_1"],
      kind: "mention",
    })
  })

  it("thread: author joins as 'spoke'; a non-audience mention is dropped (no channel auto-add)", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Bob", channelId: "t1" }))
    mockAddThreadParticipants.mockResolvedValueOnce(["author_1"])

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Bob" },
    })

    // Author joins the thread's notify set by speaking (bulk insert; Bob is
    // outside the parent audience so he's not in the rows).
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "t1", [
      { userId: "author_1", source: "spoke" },
    ])
    // Bob is outside the (private) parent audience → dropped, no mention row,
    // and NEVER auto-added to the channel roster.
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
    expect(mockCreateMentions).not.toHaveBeenCalled()
    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {
      memberAddedUserId: "author_1",
    })
  })

  it("thread: an in-audience @mention joins as a participant + gets a mention row", async () => {
    // Cara is in the parent audience; add her to it.
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Cara#0002", channelId: "t1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Cara#0002" },
    })

    // Bulk insert: author (spoke) + Cara (mention).
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "t1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["cara_1"],
      kind: "mention",
    })
    // Thread participation is NOT a channel roster row.
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("thread: @everyone notifies the audience but only the author is enrolled as a participant", async () => {
    // Audience = author + Cara; @everyone should ping Cara once but NOT
    // subscribe her permanently to the thread (only speaking / an explicit
    // @mention enrolls a participant).
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "@everyone heads up", channelId: "t1", mentionType: "everyone" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "srv_1" },
      body: { content: "@everyone heads up", mentionType: "everyone" },
    })

    // Only the author joins the notify set — the mass mention does NOT enroll Cara.
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "t1", [
      { userId: "author_1", source: "spoke" },
    ])
    // Cara is still notified once by the @everyone (a mention row is written).
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["cara_1"],
      kind: "mention",
    })
  })

  it("thread: a direct REPLY under @everyone still enrolls the replied-to user", async () => {
    // Regression guard: @everyone catches Cara into mentionTargets, and the
    // 'mention beats reply' dedup strips her from replyTargets. She must still
    // be enrolled as a participant because the author directly replied to her.
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessageInScope.mockResolvedValue({
      id: "parent_msg", authorId: "cara_1", authorName: "Cara", content: "prior",
    })
    mockGetMessage.mockResolvedValue(
      messageRow({ content: "@everyone see above", channelId: "t1", mentionType: "everyone", replyToId: "parent_msg" }),
    )

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "srv_1" },
      body: { content: "@everyone see above", mentionType: "everyone", replyToId: "parent_msg" },
    })

    // Author (spoke) + Cara (enrolled via the reply, despite @everyone dedup).
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "t1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
  })

  it("thread first reply: author joins as 'spoke' (notify-scoped)", async () => {
    // A thread's first reply (a post's old "body message") enrolls
    // participants — a message notifies only its participants, not the
    // whole server/roster.
    mockGetMessage.mockResolvedValue(messageRow({ content: "first reply", channelId: "p1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "first reply" },
    })

    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
    ])
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("thread under a forum: an in-audience @mention enrolls as a participant", async () => {
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Cara#0002", channelId: "p1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "hey @Cara#0002" },
    })

    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
  })

  it("thread under a forum + skipChildChannelUpdate: enroll STILL runs, but the parent CHILD_CHANNEL_UPDATE is suppressed", async () => {
    // The post-opening CREATE path (createMessageWithThread) routes its
    // reply as kind:"thread" (so an @-mentioned user enrolls as a
    // participant → appears in members), AND sets skipChildChannelUpdate to
    // avoid colliding with its own CHILD_CHANNEL_CREATE. Enroll and the WS
    // tick are decoupled: enroll runs, the tick does not.
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "welcome @Cara#0002", channelId: "p1" }))
    mockAddThreadParticipants.mockResolvedValueOnce(["author_1", "cara_1"])

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "welcome @Cara#0002" },
      skipChildChannelUpdate: true,
    })

    // Enroll is unaffected by the flag — Cara joins as a participant.
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {
      memberAddedUserId: "author_1",
      suppressParentProjection: true,
    })
  })

  it("public channel: mention of any server member is kept, no roster row", async () => {
    mockIsChannelPrivate.mockResolvedValue(false)
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Bob#0001" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hey @Bob#0001" },
    })

    expect(mockCreateChannelMember).not.toHaveBeenCalled()
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["bob_1"],
      kind: "mention",
    })
  })

  it("does not await a pending dispatcher on the normal delivery path", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hello" }))
    mockDispatchCommittedMessage.mockReturnValueOnce(new Promise<void>(() => {}))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
    })

    expect(result.ok).toBe(true)
    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {})
  })

  it("starts dispatch only when a deferred broadcast thunk is invoked", async () => {
    mockGetMessage.mockResolvedValue(messageRow({ content: "hello" }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
      deferBroadcast: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(mockDispatchCommittedMessage).not.toHaveBeenCalled()
    await expect(result.broadcast?.()).resolves.toBeUndefined()
    expect(mockDispatchCommittedMessage).toHaveBeenCalledWith({}, "msg_1", {})
  })

  it("suppressBroadcast (migration-backfill mode): STRUCTURAL core runs (enroll + mention rows), real-time delivery shell is fully dropped", async () => {
    // The existing-data migration's atomic primitive needs a create that
    // persists the message + enrolls participants + writes mention rows but
    // fires ZERO real-time WS (no ping / no M×N frames on historical
    // backfill). This proves the shell-OFF capability keeps the structural core
    // — unlike skipMentions, which would ALSO drop enroll (the 213-218 class bug
    // this whole knob-split guards against).
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "welcome @Cara#0002", channelId: "p1" }))

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "thread", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "welcome @Cara#0002" },
      suppressBroadcast: true,
    })

    // Structural core KEPT: participant enroll (reach-axis write) still runs...
    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
    // ...and mention ROW persistence still runs (rows are not a broadcast).
    expect(mockCreateMentions).toHaveBeenCalledWith({}, {
      messageId: "msg_1",
      userIds: ["cara_1"],
      kind: "mention",
    })
    // Real-time delivery shell FULLY dropped: no WS fan-out of any kind.
    expect(mockDispatchCommittedMessage).not.toHaveBeenCalled()
    // ...and no deferred thunk handed back either (unlike deferBroadcast).
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.broadcast).toBeUndefined()
  })
})

describe("createCommunityMessage — attachment reservation-first flow (agent path)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })
    mockGetMessage.mockResolvedValue(messageRow())
    mockListByMessageIds.mockResolvedValue([])
  })

  const replayAttachment = {
    id: "att_thumbnail",
    messageId: "msg_replay",
    targetId: "c1",
    filename: "photo.png",
    r2Key: "private-original-key",
    thumbnailR2Key: "private-thumbnail-key",
    contentType: "image/png",
    size: 100,
    width: 640,
    height: 480,
    position: 0,
  }

  it("hydrates thumbnail URLs for a same-nonce precheck replay", async () => {
    mockGetMessageByAuthorAndNonce.mockResolvedValue(
      messageRow({ id: "msg_replay", clientNonce: "nonce_replay" }),
    )
    mockListByMessageIds.mockResolvedValue([replayAttachment])

    const replay = await getCommunityMessageReplay({
      db: {} as never,
      authorId: "author_1",
      channelId: "c1",
      clientNonce: "nonce_replay",
    })

    expect(replay?.attachments).toEqual([
      expect.objectContaining({
        id: "att_thumbnail",
        url: "/api/community/channels/c1/attachments/att_thumbnail",
        thumbnailUrl: "/api/community/channels/c1/attachments/att_thumbnail/thumbnail",
      }),
    ])
  })

  it("hydrates thumbnail URLs when an insert-race recovers the committed nonce", async () => {
    mockGetMessageByAuthorAndNonce
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(messageRow({ id: "msg_replay", clientNonce: "nonce_race" }))
    mockCreateMessage.mockRejectedValue(
      Object.assign(new Error("UNIQUE constraint failed"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      }),
    )
    mockListByMessageIds.mockResolvedValue([replayAttachment])

    const replay = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "retry after unknown commit" },
      clientNonce: "nonce_race",
    })

    expect(replay).toEqual(expect.objectContaining({
      ok: true,
      deduped: true,
      attachments: [expect.objectContaining({
        thumbnailUrl: "/api/community/channels/c1/attachments/att_thumbnail/thumbnail",
      })],
    }))
  })

  it("reservation-mismatch → unreserve partial, hard-delete the orphan message, generic 400", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"]) // only 1 of 2 reserved

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hi" },
      attachmentIds: ["att_1", "att_2"],
    })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(400)
    expect(res.error).toBe("attachment not found or not attachable to this target")
    expect(mockCreateMessage).toHaveBeenCalledTimes(1)
    expect(mockUnreserveAttachments).toHaveBeenCalledWith({}, expect.objectContaining({ ids: ["att_1"] }))
    expect(mockHardDeleteMessage).toHaveBeenCalledWith({}, "msg_preminted")
    expect(mockDispatchCommittedMessage).not.toHaveBeenCalled()
  })

  it("thrown insertMessageRow error → nothing reserved yet, no unreserve, re-throw", async () => {
    mockCreateMessage.mockRejectedValue(new Error("d1_transient"))

    await expect(
      createCommunityMessage({
        db: {} as never,
        authorId: "author_1",
        target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
        body: { content: "hi" },
        attachmentIds: ["att_1", "att_2"],
      }),
    ).rejects.toThrow("d1_transient")

    expect(mockReserveAttachmentsForMessage).not.toHaveBeenCalled()
    expect(mockUnreserveAttachments).not.toHaveBeenCalled()
    expect(mockHardDeleteMessage).not.toHaveBeenCalled()
  })

  it("thrown reserve error → hard-delete the just-inserted message, re-throw", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockReserveAttachmentsForMessage.mockRejectedValue(new Error("d1_transient_reserve"))

    await expect(
      createCommunityMessage({
        db: {} as never,
        authorId: "author_1",
        target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
        body: { content: "hi" },
        attachmentIds: ["att_1"],
      }),
    ).rejects.toThrow("d1_transient_reserve")

    expect(mockHardDeleteMessage).toHaveBeenCalledWith({}, "msg_preminted")
    expect(mockUnreserveAttachments).not.toHaveBeenCalled()
  })

  it("thrown reserve error + hardDelete ALSO throws → caller sees the ORIGINAL reserve error (not the rollback error)", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockReserveAttachmentsForMessage.mockRejectedValue(new Error("d1_transient_reserve"))
    mockHardDeleteMessage.mockRejectedValue(new Error("d1_transient_rollback"))
    mockLogError.mockClear()

    await expect(
      createCommunityMessage({
        db: {} as never,
        authorId: "author_1",
        target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
        body: { content: "hi" },
        attachmentIds: ["att_1"],
      }),
    ).rejects.toThrow("d1_transient_reserve")
    // hardDelete WAS attempted; both errors are logged in one line.
    expect(mockHardDeleteMessage).toHaveBeenCalledWith({}, "msg_preminted")
    expect(mockLogError).toHaveBeenCalledWith(
      "attachment_reserve_rollback_failed",
      expect.objectContaining({
        messageId: "msg_preminted",
        insertErr: "d1_transient_reserve",
        rollbackErr: "d1_transient_rollback",
      }),
    )
  })

  it("partial reserve + unreserve throws → hardDelete STILL fires (not skipped), caller gets 400", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"]) // 1 of 2
    mockUnreserveAttachments.mockRejectedValueOnce(new Error("d1_transient_unreserve"))

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hi" },
      attachmentIds: ["att_1", "att_2"],
    })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(400)
    expect(res.error).toBe("attachment not found or not attachable to this target")
    expect(mockUnreserveAttachments).toHaveBeenCalledTimes(1)
    // hardDelete must NOT be skipped just because unreserve threw first — the
    // orphan message row still needs cleanup.
    expect(mockHardDeleteMessage).toHaveBeenCalledWith({}, "msg_preminted")
  })

  it("partial reserve + unreserve AND hardDelete both throw → caller still gets 400 envelope (no rethrow)", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"]) // 1 of 2
    mockUnreserveAttachments.mockRejectedValueOnce(new Error("d1_transient_unreserve"))
    mockHardDeleteMessage.mockRejectedValue(new Error("d1_transient_rollback"))

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hi" },
      attachmentIds: ["att_1", "att_2"],
    })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(400)
    expect(res.error).toBe("attachment not found or not attachable to this target")
  })

  it("expectedSeq CAS-null → no reserve, no unreserve, no hardDelete, returns seq_conflict", async () => {
    mockCreateMessage.mockResolvedValue(null) // CAS-null (returned, not thrown)

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hi" },
      attachmentIds: ["att_1"],
      expectedSeq: 5,
    })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.status).toBe(409)
    expect(res.error).toBe("seq_conflict")
    expect(mockReserveAttachmentsForMessage).not.toHaveBeenCalled()
    expect(mockUnreserveAttachments).not.toHaveBeenCalled()
    expect(mockHardDeleteMessage).not.toHaveBeenCalled()
  })

  it("attachment-only bot send (empty text) is NOT rejected by the empty-body guard", async () => {
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"])
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockListByMessageIds.mockResolvedValue([
      {
        id: "att_1",
        filename: "photo.png",
        r2Key: "channel/c1/uuid/photo.png",
        contentType: "image/png",
        size: 100,
        width: null,
        height: null,
        messageId: "msg_preminted",
        position: 0,
      },
    ])

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "" }, // <- attachment-only send
      attachmentIds: ["att_1"],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(mockCreateMessage).toHaveBeenCalledTimes(1)
  })

  it("happy path — reserved rows are projected as CreatedAttachment via listByMessageIds", async () => {
    mockReserveAttachmentsForMessage.mockResolvedValue(["att_1"])
    mockCreateMessage.mockResolvedValue({ id: "msg_preminted" })
    mockListByMessageIds.mockResolvedValue([
      {
        id: "att_1",
        filename: "photo.png",
        targetId: "c1",
        r2Key: "channel/c1/uuid/photo.png",
        thumbnailR2Key: "channel/c1/uuid/photo.png.thumbnail.jpg",
        contentType: "image/png",
        size: 100,
        width: null,
        height: null,
        messageId: "msg_preminted",
        position: 0,
      },
    ])

    const res = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hi" },
      attachmentIds: ["att_1"],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.attachments).toEqual([
      expect.objectContaining({
        id: "att_1",
        filename: "photo.png",
        // id-addressed render URL (attachments fold) — served by the canonical
        // channels/{targetId}/attachments/{attachmentId} door.
        url: "/api/community/channels/c1/attachments/att_1",
        thumbnailUrl: "/api/community/channels/c1/attachments/att_1/thumbnail",
      }),
    ])
    expect(mockUnreserveAttachments).not.toHaveBeenCalled()
  })
})
