import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetMessageInScope = vi.fn()
const mockHardDeleteMessage = vi.fn()
const mockGetUserInternal = vi.fn()
const mockCreateAttachment = vi.fn()
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
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: (...a: unknown[]) => mockLogError(...a),
    }),
    queries: {
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
        getMessageInScope: (...a: unknown[]) => mockGetMessageInScope(...a),
        hardDeleteMessage: (...a: unknown[]) => mockHardDeleteMessage(...a),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
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

const mockFanOutToChannel = vi.fn()
const mockFanOutToDM = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
vi.mock("./fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
  broadcastToUserSafe: (...a: unknown[]) => mockBroadcastToUserSafe(...a),
}))

const mockBroadcastToUser = vi.fn()
vi.mock("../broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

const mockLogAudit = vi.fn()
vi.mock("./audit", async () => {
  const actual = await vi.importActual<typeof import("./audit")>("./audit")
  return {
    ...actual,
    logAudit: (...a: unknown[]) => mockLogAudit(...a),
  }
})

import {
  createCommunityMessage,
  isDmTarget,
  isThreadTarget,
  isChannelTarget,
  type MessageTarget,
} from "./message-handler"

describe("message-target predicates", () => {
  const channel: MessageTarget = { kind: "channel", channelId: "c1", serverId: "s1" }
  const thread: MessageTarget = { kind: "thread", channelId: "t1", parentChannelId: "c1", serverId: "s1" }
  const dm: MessageTarget = { kind: "dm", dmId: "d1", otherUserId: "u1" }

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

describe("createCommunityMessage — audit relocation (plan §10)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockGetMessage.mockResolvedValue(messageRow())
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
  })

  it("writes exactly ONE MESSAGE_AUTHORED_AS_BOT audit row for a bot author", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })

    const result = await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
      source: "cli",
    })

    expect(result.ok).toBe(true)
    expect(mockLogAudit).toHaveBeenCalledTimes(1)
    expect(mockLogAudit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        serverId: "srv_1",
        actorId: "author_1",
        action: "community.message.authored_as_bot",
        targetType: "message",
        targetId: "msg_1",
      }),
    )
    const [, action] = mockLogAudit.mock.calls[0]!
    const changes = JSON.parse(action.changes)
    expect(changes).toEqual({
      botId: "author_1",
      target: "channel",
      targetId: "c1",
      messageId: "msg_1",
      source: "cli",
    })
  })

  it("does not write an audit row for a human author", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
    })

    expect(mockLogAudit).not.toHaveBeenCalled()
  })

  it("defaults source to 'web' when omitted", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: { content: "hello" },
    })

    const [, action] = mockLogAudit.mock.calls[0]!
    expect(JSON.parse(action.changes).source).toBe("web")
  })

  it("DM target: serverId is null and targetId is the dmId", async () => {
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })
    mockGetMessage.mockResolvedValue(messageRow({ channelId: null, dmConversationId: "dm_1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "dm", dmId: "dm_1", otherUserId: "u2" },
      body: { content: "hello" },
      source: "daemon-http",
    })

    expect(mockLogAudit).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ serverId: null }),
    )
    const [, action] = mockLogAudit.mock.calls[0]!
    expect(JSON.parse(action.changes)).toEqual({
      botId: "author_1",
      target: "dm",
      targetId: "dm_1",
      messageId: "msg_1",
      source: "daemon-http",
    })
  })
})

describe("createCommunityMessage — CAS race (plans/fix-agent-send-race-condition.md)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
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
    expect(mockCreateAttachment).not.toHaveBeenCalled()
    expect(mockCreateMentions).not.toHaveBeenCalled()
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
    expect(mockFanOutToDM).not.toHaveBeenCalled()
    expect(mockLogAudit).not.toHaveBeenCalled()
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

describe("createCommunityMessage — attachment width/height reach the live WS broadcast", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: false, deletedAt: null })
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
  })

  it("includes width/height on an image attachment in the MESSAGE_CREATE broadcast payload", async () => {
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockCreateAttachment.mockResolvedValue({
      id: "att_1",
      filename: "photo.png",
      r2Key: "channel/c1/uuid/photo.png",
      contentType: "image/png",
      size: 1000,
      width: 1920,
      height: 1080,
    })
    mockGetMessage.mockResolvedValue(messageRow())

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "channel", channelId: "c1", serverId: "srv_1" },
      body: {
        content: "hello",
        attachments: [
          { url: "/api/community/media/channel/c1/uuid/photo.png", filename: "photo.png", contentType: "image/png", size: 1000, width: 1920, height: 1080 },
        ],
      },
    })

    expect(mockCreateAttachment).toHaveBeenCalledWith({}, expect.objectContaining({ width: 1920, height: 1080, r2Key: "channel/c1/uuid/photo.png" }))
    expect(mockFanOutToChannel).toHaveBeenCalledTimes(1)
    const [, event] = mockFanOutToChannel.mock.calls[0]!
    expect(event.message.attachments).toEqual([
      expect.objectContaining({ width: 1920, height: 1080 }),
    ])
  })
})

describe("createCommunityMessage — @Name#0042 mention disambiguation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMessage.mockResolvedValue({ id: "msg_1" })
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
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
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockFanOutToDM.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockBroadcastToUserSafe.mockResolvedValue(undefined)
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
    expect(mockBroadcastToUserSafe).not.toHaveBeenCalled()
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

  it("@everyone/@here is clamped to the audience (author excluded → only Cara)", async () => {
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

  it("forum_post: author joins as 'spoke' just like a thread (notify-scoped)", async () => {
    // A forum_post enrolls participants identically to a thread — a message in
    // a post notifies only its participants, not the whole server/roster.
    mockGetMessage.mockResolvedValue(messageRow({ content: "first reply", channelId: "p1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "forum_post", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "first reply" },
    })

    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
    ])
    expect(mockCreateChannelMember).not.toHaveBeenCalled()
  })

  it("forum_post: an in-audience @mention enrolls as a participant", async () => {
    mockGetPrivateChannelAudienceUserIds.mockResolvedValue(["author_1", "cara_1"])
    mockGetMessage.mockResolvedValue(messageRow({ content: "hey @Cara#0002", channelId: "p1" }))

    await createCommunityMessage({
      db: {} as never,
      authorId: "author_1",
      target: { kind: "forum_post", channelId: "p1", parentChannelId: "forum_1", serverId: "srv_1" },
      body: { content: "hey @Cara#0002" },
    })

    expect(mockAddThreadParticipants).toHaveBeenCalledWith({}, "p1", [
      { userId: "author_1", source: "spoke" },
      { userId: "cara_1", source: "mention" },
    ])
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
})

describe("createCommunityMessage — attachment reservation-first flow (agent path)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserInternal.mockResolvedValue({ id: "author_1", isBot: true, deletedAt: null })
    mockFanOutToChannel.mockResolvedValue(undefined)
    mockBroadcastToUser.mockResolvedValue(undefined)
    mockGetMessage.mockResolvedValue(messageRow())
    mockListByMessageIds.mockResolvedValue([])
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
    expect(mockFanOutToChannel).not.toHaveBeenCalled()
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
      body: { content: "hi" },
      attachmentIds: ["att_1"],
    })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.attachments).toEqual([
      expect.objectContaining({
        id: "att_1",
        filename: "photo.png",
        url: "/api/community/media/channel/c1/uuid/photo.png",
      }),
    ])
    expect(mockUnreserveAttachments).not.toHaveBeenCalled()
  })
})
