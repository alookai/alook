import { describe, it, expect, vi, beforeEach } from "vitest"

const mockCreateMessage = vi.fn()
const mockGetMessage = vi.fn()
const mockGetUserInternal = vi.fn()
const mockCreateAttachment = vi.fn()
const mockListMembers = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockCreateMentions = vi.fn()
const mockGetChannel = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMessage: {
        createMessage: (...a: unknown[]) => mockCreateMessage(...a),
        getMessage: (...a: unknown[]) => mockGetMessage(...a),
      },
      communityAttachment: {
        createAttachment: (...a: unknown[]) => mockCreateAttachment(...a),
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
      },
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
    },
  }
})

const mockFanOutToChannel = vi.fn()
const mockFanOutToDM = vi.fn()
vi.mock("./fanout", () => ({
  fanOutToChannel: (...a: unknown[]) => mockFanOutToChannel(...a),
  fanOutToDM: (...a: unknown[]) => mockFanOutToDM(...a),
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

import { createCommunityMessage } from "./message-handler"

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
