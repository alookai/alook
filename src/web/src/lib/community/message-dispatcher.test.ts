import { beforeEach, describe, expect, it, vi } from "vitest"

const mockWaitUntil = vi.fn()
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: mockWaitUntil }, env: {} }),
}))

const mockGetMessage = vi.fn()
const mockGetWakeContextMessageInScope = vi.fn()
const mockListWakeContextMessagesBefore = vi.fn()
const mockGetMessageClientNonceForDelivery = vi.fn()
const mockGetChannel = vi.fn()
const mockListAttention = vi.fn()
const mockListAttachments = vi.fn()
const mockResolveRecipients = vi.fn()
const mockResolveNotificationRecipients = vi.fn()
const mockResolveEligibility = vi.fn()
const mockFindWakeCandidates = vi.fn()
const mockLogWarn = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      child() { return this },
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => mockLogWarn(...args),
    }),
    withD1Retry: (run: () => Promise<unknown>) => run(),
    queries: {
      communityMessage: {
        getMessage: (...args: unknown[]) => mockGetMessage(...args),
        getWakeContextMessageInScope: (...args: unknown[]) =>
          mockGetWakeContextMessageInScope(...args),
        listWakeContextMessagesBefore: (...args: unknown[]) =>
          mockListWakeContextMessagesBefore(...args),
        getMessageClientNonceForDelivery: (...args: unknown[]) =>
          mockGetMessageClientNonceForDelivery(...args),
      },
      communityChannel: {
        getChannel: (...args: unknown[]) => mockGetChannel(...args),
      },
      communityMention: {
        listMessageAttentionTargets: (...args: unknown[]) => mockListAttention(...args),
      },
      communityAttachment: {
        listMessageAttachments: (...args: unknown[]) => mockListAttachments(...args),
      },
      communityMembersResolver: {
        resolveChannelContentRecipientUserIds: (...args: unknown[]) => mockResolveRecipients(...args),
        resolveChannelNotificationRecipientUserIds: (...args: unknown[]) => mockResolveNotificationRecipients(...args),
      },
      communityNotificationEligibility: {
        resolveNotificationEligibilityForUsers: (...args: unknown[]) => mockResolveEligibility(...args),
      },
      communityNotificationSetting: {
        policyAllows: actual.queries.communityNotificationSetting.policyAllows,
      },
      communityBot: {
        findWakeCandidates: (...args: unknown[]) => mockFindWakeCandidates(...args),
      },
    },
  }
})

const mockSendMessageDeliveryBatch = vi.fn()
vi.mock("./message-delivery-transport", () => ({
  sendMessageDeliveryBatch: (...args: unknown[]) => mockSendMessageDeliveryBatch(...args),
}))
const mockEnqueueQueueTasks = vi.fn()
vi.mock("./queue-producer", () => ({
  enqueueQueueTasks: (...args: unknown[]) => mockEnqueueQueueTasks(...args),
}))
const mockSelectJevWakeCandidates = vi.fn()
vi.mock("./jev-wake-gate", () => ({
  selectJevWakeCandidates: (...args: unknown[]) => mockSelectJevWakeCandidates(...args),
}))

import { dispatchCommittedMessage, planCommittedMessage } from "./message-dispatcher"
import { deriveCommunityDeliveryOperationId } from "@alook/shared"

const message = {
  id: "msg_1",
  authorId: "author_1",
  authorName: "Author",
  authorEmail: "a@example.test",
  authorImage: null,
  content: "hello",
  type: "default",
  mentionType: null,
  replyToId: null,
  embeds: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  channelId: "c1",
  clientNonce: "nonce_1",
  seq: 7,
}

function wakeContextRow(overrides: Partial<{
  id: string
  authorId: string
  authorName: string
  authorDiscriminator: string
  authorIsBot: boolean
  content: string
  type: string
  replyToId: string | null
  seq: number
  createdAt: string
  channelId: string
}> = {}) {
  return {
    id: "context_1",
    authorId: "human_1",
    authorName: "Private Human Name",
    authorDiscriminator: "1234",
    authorIsBot: false,
    content: "context",
    type: "default",
    replyToId: null,
    seq: 1,
    createdAt: "2026-08-17T00:00:00.000Z",
    channelId: "c1",
    ...overrides,
  }
}

const channel = {
  id: "c1",
  serverId: "s1",
  categoryId: null,
  name: "general",
  type: "text",
  topic: "",
  position: 0,
  parentChannelId: null,
  creatorId: "author_1",
  messageCount: 7,
  archived: false,
  parentMessageId: null,
  lastMessageAt: "2026-08-18T00:00:00.000Z",
  createdAt: "2026-08-01T00:00:00.000Z",
}

function state(overrides: Partial<{
  currentLevel: "all" | "mentions" | "nothing"
  hasAttention: boolean
  isUnread: boolean
  isReadable: boolean
}> = {}) {
  return {
    currentLevel: "all" as const,
    hasAttention: false,
    isUnread: true,
    isReadable: true,
    ...overrides,
  }
}

describe("planCommittedMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMessage.mockResolvedValue(message)
    mockGetWakeContextMessageInScope.mockResolvedValue(null)
    mockListWakeContextMessagesBefore.mockResolvedValue({ messages: [], hasMore: false })
    mockGetMessageClientNonceForDelivery.mockResolvedValue("nonce_1")
    mockGetChannel.mockResolvedValue(channel)
    mockListAttachments.mockResolvedValue([])
    mockListAttention.mockResolvedValue([
      { userId: "u_mentions", kind: "mention" },
      { userId: "u_mention_only", kind: "mention" },
      { userId: "bot_1", kind: "mention" },
    ])
    mockResolveRecipients.mockImplementation(async (_db, channelId: string) =>
      channelId === "c1"
        ? ["author_1", "u_all", "u_mentions", "bot_1"]
        : [],
    )
    mockResolveNotificationRecipients.mockImplementation((db, id, run) => run("thread-participants", () => mockResolveRecipients(db, id)))
    mockResolveEligibility.mockResolvedValue(new Map([
      ["author_1", state()],
      ["u_all", state()],
      ["u_mentions", state({ currentLevel: "mentions", hasAttention: true })],
      ["u_mention_only", state({ currentLevel: "mentions", hasAttention: true })],
      ["bot_1", state({ hasAttention: true })],
    ]))
    mockFindWakeCandidates.mockResolvedValue([
      {
        botUserId: "bot_1",
        name: "Bot",
        discriminator: "0001",
        instruction: "Own support triage",
        machineId: "m1",
        runtime: "codex",
      },
    ])
    mockSelectJevWakeCandidates.mockImplementation(async (input) => input.candidates)
    mockSendMessageDeliveryBatch.mockResolvedValue(undefined)
    mockEnqueueQueueTasks.mockResolvedValue(undefined)
  })

  it("derives content, notification, mention, and bot targets from one D1 plan", async () => {
    mockGetMessage.mockResolvedValue({ ...message, content: "@Bot#0001 hello" })
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "u_all", "u_mentions", "bot_1"])
    expect(plan.unreadPlainUserIds).toEqual(["u_all"])
    expect(plan.unreadMentionUserIds).toEqual(["u_mentions", "bot_1"])
    expect(plan.mentionUserIds).toEqual(["u_mentions", "u_mention_only", "bot_1"])
    expect(plan.wakeBotUserIds).toEqual(["bot_1"])
    expect(plan.wakeGateInput.candidates).toEqual([
      expect.objectContaining({
        botUserId: "bot_1",
        directlyMentioned: true,
        isReplyTarget: false,
      }),
    ])
    expect(plan.pushUserIds).toEqual(["u_all", "u_mentions", "bot_1", "u_mention_only"])
    expect(plan.messageEvent).toMatchObject({
      type: "community:message.create",
      channelId: "c1",
      serverId: "s1",
      message: { id: "msg_1", seq: 7, clientNonce: "nonce_1" },
    })
    expect(mockResolveEligibility).toHaveBeenCalledWith(
      {},
      ["u_all", "u_mentions", "bot_1", "u_mention_only"],
      "msg_1",
    )
    expect(mockFindWakeCandidates).toHaveBeenCalledWith({}, {
      recipients: ["u_all", "u_mentions", "bot_1"],
      channelId: "c1",
      newSeq: 7,
    })
  })

  it("runs content-recipient phases through the dispatcher retry callback", async () => {
    mockResolveRecipients.mockImplementation((
      _db: unknown,
      _channelId: string,
      run: (phase: "channel-type", query: () => Promise<string[]>) => Promise<string[]>,
    ) => run("channel-type", async () => ["author_1"]))
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map())
    mockFindWakeCandidates.mockResolvedValue([])

    const plan = await planCommittedMessage({} as never, "msg_1")

    expect(plan.contentUserIds).toEqual(["author_1"])
  })

  it("rejects a committed message whose channel lookup resolves outside its scope", async () => {
    mockGetChannel.mockResolvedValue({ ...channel, id: "other_channel" })

    await expect(planCommittedMessage({} as never, "msg_1"))
      .rejects.toThrow("committed message scope not found")
  })

  it("delivers content to passive readers without adding unread, mention, or wake candidates", async () => {
    mockGetChannel.mockResolvedValue({ ...channel, type: "thread", parentChannelId: "parent" })
    mockResolveRecipients.mockResolvedValue(["author_1", "reader", "passive_bot", "u_all"])
    mockResolveNotificationRecipients.mockResolvedValue(["author_1", "u_all"])
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map([["u_all", state()]]))
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "passive_bot",
      name: "Passive",
      discriminator: "0002",
      instruction: "",
      machineId: "m2",
      runtime: "codex",
    }])
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toContain("reader")
    expect(plan.contentUserIds).toContain("passive_bot")
    expect(plan.unreadPlainUserIds).toEqual(["u_all"])
    expect(plan.unreadMentionUserIds).toEqual([])
    expect(plan.mentionUserIds).toEqual([])
    expect(plan.wakeBotUserIds).toEqual([])
    expect(plan.pushUserIds).toEqual(["u_all"])
    expect(mockResolveEligibility).toHaveBeenCalledWith({}, ["u_all"], "msg_1")
    expect(mockFindWakeCandidates).toHaveBeenCalledWith({}, expect.objectContaining({ recipients: ["u_all"] }))
    expect(mockListWakeContextMessagesBefore).not.toHaveBeenCalled()
  })

  it("rehydrates attachment dimensions and reply preview from committed rows", async () => {
    mockGetMessage.mockResolvedValue({ ...message, replyToId: "reply_1" })
    mockGetWakeContextMessageInScope.mockResolvedValue(wakeContextRow({
      id: "reply_1",
      authorName: "Earlier",
      content: "previous message",
    }))
    mockListAttachments.mockResolvedValue([{
      id: "att_1",
      targetId: "c1",
      filename: "photo.png",
      thumbnailR2Key: "thumb",
      contentType: "image/png",
      size: 1000,
      width: 1920,
      height: 1080,
    }])
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.messageEvent.message.replyTo).toMatchObject({
      id: "reply_1",
      authorName: "Earlier",
      text: "previous message",
    })
    expect(plan.messageEvent.message.attachments).toEqual([
      expect.objectContaining({
        id: "att_1",
        width: 1920,
        height: 1080,
        thumbnailUrl: "/api/community/channels/c1/attachments/att_1/thumbnail",
      }),
    ])
  })

  it("keeps a reply target when @everyone collapses its stored attention row to mention", async () => {
    mockGetMessage.mockResolvedValue({
      ...message,
      content: "",
      type: "system",
      mentionType: "everyone",
      replyToId: "reply_1",
    })
    mockGetWakeContextMessageInScope.mockResolvedValue(wakeContextRow({
      id: "reply_1",
      authorId: "bot_1",
      authorName: "Bot",
      authorDiscriminator: "0001",
      authorIsBot: true,
      content: "previous message",
    }))
    mockListAttention.mockResolvedValue([{ userId: "bot_1", kind: "mention" }])
    mockListAttachments.mockResolvedValue([{
      id: "att_1",
      targetId: "c1",
      filename: "private-name.png",
      thumbnailR2Key: null,
      contentType: "image/png",
      size: 1000,
      width: 100,
      height: 100,
    }])
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "bot_1",
      name: null,
      discriminator: "0001",
      instruction: "",
      machineId: "m1",
      runtime: "codex",
    }])

    const plan = await planCommittedMessage({} as never, "msg_1")

    expect(plan.wakeGateInput.message).toEqual({
      text: "",
      type: "system",
      broadcastMention: true,
      attachmentContentTypes: ["image/png"],
    })
    expect(plan.wakeGateInput.candidates).toEqual([
      expect.objectContaining({
        botUserId: "bot_1",
        name: null,
        instruction: "",
        directlyMentioned: false,
        isReplyTarget: true,
      }),
    ])
    expect(JSON.stringify(plan.wakeGateInput)).not.toContain("private-name.png")
  })

  it("builds scoped reply, opener, and recent context once with merged roles and private human aliases", async () => {
    mockGetMessage.mockResolvedValue({
      ...message,
      channelId: "thread_1",
      replyToId: "reply_1",
      seq: 10,
    })
    mockGetChannel.mockResolvedValue({
      ...channel,
      id: "thread_1",
      type: "thread",
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
    })
    mockResolveRecipients.mockImplementation(async (_db, channelId: string) =>
      channelId === "thread_1" ? ["author_1", "bot_1"] : ["parent_viewer"],
    )
    mockResolveEligibility.mockResolvedValue(new Map([["bot_1", state()]]))

    const recentHuman = wakeContextRow({
      id: "recent_1",
      content: "Earlier human context",
      seq: 7,
      createdAt: "2026-08-17T00:00:01.000Z",
      channelId: "thread_1",
    })
    const ancestor = wakeContextRow({
      id: "ancestor_1",
      authorId: "bot_2",
      authorName: "Helper",
      authorDiscriminator: "0002",
      authorIsBot: true,
      content: "Original assignment",
      seq: 8,
      createdAt: "2026-08-17T00:00:02.000Z",
      channelId: "thread_1",
    })
    const reply = wakeContextRow({
      id: "reply_1",
      content: "Do that",
      replyToId: "ancestor_1",
      seq: 9,
      createdAt: "2026-08-17T00:00:03.000Z",
      channelId: "thread_1",
    })
    const opener = wakeContextRow({
      id: "opener_1",
      content: "Forum incident",
      seq: 2,
      createdAt: "2026-08-17T00:00:00.000Z",
      channelId: "forum_1",
    })
    mockListWakeContextMessagesBefore.mockResolvedValue({
      messages: [recentHuman, ancestor, reply],
      hasMore: true,
    })
    mockGetWakeContextMessageInScope.mockImplementation(async (_db, id) => ({
      reply_1: reply,
      ancestor_1: ancestor,
      opener_1: opener,
    })[id] ?? null)

    const plan = await planCommittedMessage({} as never, "msg_1")

    expect(mockListWakeContextMessagesBefore).toHaveBeenCalledWith({}, {
      channelId: "thread_1",
      beforeSeq: 10,
      limit: 6,
    })
    expect(mockGetWakeContextMessageInScope).toHaveBeenCalledWith(
      {},
      "opener_1",
      { channelId: "forum_1" },
    )
    expect(plan.wakeGateInput.conversation).toEqual({
      available: true,
      truncated: true,
      messages: [
        expect.objectContaining({
          text: "Forum incident",
          author: { kind: "human", alias: "member_1" },
          roles: ["thread_opener"],
        }),
        expect.objectContaining({
          text: "Earlier human context",
          author: { kind: "human", alias: "member_1" },
          roles: ["recent"],
        }),
        expect.objectContaining({
          text: "Original assignment",
          author: { kind: "bot", handle: "Helper#0002" },
          roles: ["reply_ancestor", "recent"],
        }),
        expect.objectContaining({
          text: "Do that",
          author: { kind: "human", alias: "member_1" },
          roles: ["reply_target", "recent"],
        }),
      ],
    })
    const serialized = JSON.stringify(plan.wakeGateInput.conversation)
    expect(serialized).not.toContain("human_1")
    expect(serialized).not.toContain("Private Human Name")
  })

  it("fails open to empty context when a context-only lookup fails", async () => {
    mockListWakeContextMessagesBefore.mockRejectedValue(new Error("D1 context unavailable"))

    const plan = await planCommittedMessage({} as never, "msg_1")

    expect(plan.wakeGateInput.conversation).toEqual({
      available: false,
      messages: [],
      truncated: false,
    })
    expect(mockLogWarn).toHaveBeenCalledWith(
      "committed_message_jev_context_failed_open",
      { messageId: "msg_1" },
    )
  })

  it("keeps an explicit bot mention when it co-occurs with @everyone", async () => {
    mockGetMessage.mockResolvedValue({
      ...message,
      content: "@everyone @Bot#0001 please investigate",
      mentionType: "everyone",
    })
    mockListAttention.mockResolvedValue([{ userId: "bot_1", kind: "mention" }])

    const plan = await planCommittedMessage({} as never, "msg_1")

    expect(plan.wakeGateInput.message.broadcastMention).toBe(true)
    expect(plan.wakeGateInput.candidates).toEqual([
      expect.objectContaining({
        botUserId: "bot_1",
        directlyMentioned: true,
        isReplyTarget: false,
      }),
    ])
  })

  it("keeps forum-thread participants, mention-only attention, and parent access distinct", async () => {
    mockGetMessage.mockResolvedValue({ ...message, channelId: "t1" })
    mockGetChannel.mockResolvedValue({
      ...channel,
      id: "t1",
      type: "thread",
      parentChannelId: "forum_1",
      messageCount: 3,
    })
    mockListAttention.mockResolvedValue([{ userId: "parent_viewer", kind: "mention" }])
    mockResolveRecipients.mockImplementation(async (_db, channelId: string) => {
      if (channelId === "t1") return ["author_1", "participant_1"]
      if (channelId === "forum_1") return ["participant_1", "parent_viewer"]
      return []
    })
    mockResolveEligibility.mockResolvedValue(new Map([
      ["participant_1", state()],
      ["author_1", state()],
      ["parent_viewer", state({ hasAttention: true })],
    ]))
    mockFindWakeCandidates.mockResolvedValue([])

    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "participant_1"])
    expect(plan.mentionUserIds).toEqual(["parent_viewer"])
    expect(plan.pushUserIds).toEqual(["participant_1", "parent_viewer"])
    expect(plan.parentProjectionUserIds).toEqual(["participant_1", "parent_viewer"])
    expect(plan.parentProjection).toMatchObject({
      parentChannelId: "forum_1",
      channelId: "t1",
      changes: { messageCount: 3 },
    })
  })

  it("uses the resolved access snapshot for a private server channel", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "private_member"])
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["author_1", state()],
      ["private_member", state()],
    ]))
    mockFindWakeCandidates.mockResolvedValue([])

    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "private_member"])
    expect(plan.unreadPlainUserIds).toEqual(["private_member"])
    expect(plan.pushUserIds).toEqual(["private_member"])
  })

  it("plans a DM from its two resolved members without server projections", async () => {
    mockGetChannel.mockResolvedValue({
      ...channel,
      serverId: null,
      type: "dm",
      parentChannelId: null,
    })
    mockResolveRecipients.mockResolvedValue(["author_1", "dm_peer"])
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["author_1", state()],
      ["dm_peer", state()],
    ]))
    mockFindWakeCandidates.mockResolvedValue([])

    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "dm_peer"])
    expect(plan.pushUserIds).toEqual(["dm_peer"])
    expect(plan.messageEvent).not.toHaveProperty("serverId")
    expect(plan).not.toHaveProperty("parentProjection")
  })

  it("keeps the author in content while excluding them from every side effect", async () => {
    mockListAttention.mockResolvedValue([{ userId: "author_1", kind: "mention" }])
    mockResolveRecipients.mockResolvedValue(["author_1"])
    mockResolveEligibility.mockResolvedValue(new Map([["author_1", state({ hasAttention: true })]]))
    mockFindWakeCandidates.mockResolvedValue([
      {
        botUserId: "author_1",
        name: "Author Bot",
        discriminator: "0003",
        instruction: "",
        machineId: "m1",
        runtime: "codex",
      },
    ])

    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1"])
    expect(plan.unreadPlainUserIds).toEqual([])
    expect(plan.unreadMentionUserIds).toEqual([])
    expect(plan.mentionUserIds).toEqual([])
    expect(plan.wakeBotUserIds).toEqual([])
    expect(plan.pushUserIds).toEqual([])
    expect(mockFindWakeCandidates).toHaveBeenCalledWith({}, {
      recipients: [],
      channelId: "c1",
      newSeq: 7,
    })
  })

  it("produces an empty plan when the committed scope currently has no readable audience", async () => {
    mockResolveRecipients.mockResolvedValue([])
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map())
    mockFindWakeCandidates.mockResolvedValue([])

    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual([])
    expect(plan.unreadPlainUserIds).toEqual([])
    expect(plan.unreadMentionUserIds).toEqual([])
    expect(plan.mentionUserIds).toEqual([])
    expect(plan.wakeBotUserIds).toEqual([])
    expect(plan.pushUserIds).toEqual([])
  })

  it("filters muted, caught-up, and unread-ineligible users consistently", async () => {
    mockResolveEligibility.mockResolvedValue(new Map([
      ["author_1", state()],
      ["u_all", state({ currentLevel: "nothing" })],
      ["u_mentions", state({ currentLevel: "mentions", hasAttention: false })],
      ["u_mention_only", state({ hasAttention: true, isUnread: false })],
      ["bot_1", state({ isReadable: false })],
    ]))
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.unreadPlainUserIds).toEqual([])
    expect(plan.unreadMentionUserIds).toEqual([])
    expect(plan.mentionUserIds).toEqual([])
    expect(plan.wakeBotUserIds).toEqual([])
    expect(plan.pushUserIds).toEqual([])
  })

  it("accepts only an in-scope structural participant outcome", async () => {
    const plan = await planCommittedMessage(
      {} as never,
      "msg_1",
      { memberAddedUserId: "u_all" },
    )
    expect(plan.memberAdded).toEqual({ userId: "u_all", serverId: "s1", channelId: "c1" })
    await expect(planCommittedMessage(
      {} as never,
      "msg_1",
      { memberAddedUserId: "outside" },
    )).rejects.toThrow("outside message scope")
  })

  it("removes a stale participant that no longer has readable access", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "u_mentions"])
    mockResolveNotificationRecipients.mockResolvedValue(["author_1", "u_all", "u_mentions", "bot_1"])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["author_1", state()],
      ["u_all", state({ isReadable: false })],
      ["u_mentions", state({ hasAttention: true })],
      ["u_mention_only", state({ hasAttention: true })],
      ["bot_1", state({ isReadable: false })],
    ]))
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "u_mentions"])
    expect(plan.wakeBotUserIds).toEqual([])
    expect(plan.pushUserIds).toEqual(["u_mentions", "u_mention_only"])
  })

  it("deduplicates notification and attention candidates without consulting passive readers", async () => {
    mockGetChannel.mockResolvedValue({ ...channel, type: "thread", parentChannelId: "parent" })
    mockResolveRecipients.mockResolvedValue(["author_1", "reader", "u_all", "u_mentions"])
    mockResolveNotificationRecipients.mockResolvedValue(["author_1", "u_all", "u_all", "u_mentions", "outside"])
    mockListAttention.mockResolvedValue([
      { userId: "author_1", kind: "mention" },
      { userId: "u_mentions", kind: "mention" },
      { userId: "u_mentions", kind: "mention" },
      { userId: "u_mention_only", kind: "mention" },
    ])
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(mockResolveEligibility).toHaveBeenCalledWith({}, ["u_all", "u_mentions", "outside", "u_mention_only"], "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "reader", "u_all", "u_mentions"])
    expect(plan.unreadPlainUserIds).toEqual(["u_all"])
    expect(plan.unreadMentionUserIds).toEqual(["u_mentions"])
    expect(plan.mentionUserIds).toEqual(["u_mentions", "u_mention_only"])
    expect(plan.pushUserIds).toEqual(["u_all", "u_mentions", "u_mention_only"])
    expect(plan.wakeBotUserIds).toEqual([])
  })

  it.each(["text", "forum", "dm"])("reuses the content audience for %s notification planning", async (type) => {
    mockGetChannel.mockResolvedValue({ ...channel, type })
    await planCommittedMessage({} as never, "msg_1")
    expect(mockResolveRecipients).toHaveBeenCalledOnce()
    expect(mockResolveNotificationRecipients).not.toHaveBeenCalled()
  })

  it("is stable when rerun from the same committed facts", async () => {
    const first = await planCommittedMessage({} as never, "msg_1")
    const second = await planCommittedMessage({} as never, "msg_1")
    expect(second).toEqual(first)
    expect(first.operationId).toBe(await deriveCommunityDeliveryOperationId("msg_1"))
  })
})

describe("dispatchCommittedMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMessage.mockResolvedValue(message)
    mockGetChannel.mockResolvedValue(channel)
    mockGetWakeContextMessageInScope.mockResolvedValue(null)
    mockListWakeContextMessagesBefore.mockResolvedValue({ messages: [], hasMore: false })
    mockGetMessageClientNonceForDelivery.mockResolvedValue("nonce_1")
    mockListAttachments.mockResolvedValue([])
    mockListAttention.mockResolvedValue([])
    mockResolveRecipients.mockResolvedValue(["author_1"])
    mockResolveNotificationRecipients.mockImplementation(
      (db, id, run) => run("thread-participants", () => mockResolveRecipients(db, id)),
    )
    mockResolveEligibility.mockResolvedValue(new Map())
    mockFindWakeCandidates.mockResolvedValue([])
    mockSelectJevWakeCandidates.mockImplementation(async (input) => input.candidates)
    mockSendMessageDeliveryBatch.mockResolvedValue(undefined)
    mockEnqueueQueueTasks.mockResolvedValue(undefined)
  })

  it("registers one fail-open dispatch and sends browser plus queue plans", async () => {
    const work = dispatchCommittedMessage({} as never, "msg_1")
    expect(mockWaitUntil).toHaveBeenCalledWith(work)
    await expect(work).resolves.toBeUndefined()
    expect(mockSendMessageDeliveryBatch).toHaveBeenCalledTimes(1)
    expect(mockSendMessageDeliveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg_1" }),
      await deriveCommunityDeliveryOperationId("msg_1"),
    )
    expect(mockEnqueueQueueTasks).toHaveBeenCalledWith([])
  })

  it("forwards parent projections in the browser delivery batch", async () => {
    mockGetMessage.mockResolvedValue({ ...message, channelId: "t1" })
    mockGetChannel.mockResolvedValue({
      ...channel,
      id: "t1",
      type: "thread",
      parentChannelId: "forum_1",
      messageCount: 3,
    })
    mockResolveRecipients.mockImplementation(async (_db, channelId: string) =>
      channelId === "forum_1" ? ["parent_viewer"] : ["author_1"],
    )

    await dispatchCommittedMessage({} as never, "msg_1")

    expect(mockSendMessageDeliveryBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        parentProjection: expect.objectContaining({
          parentChannelId: "forum_1",
          channelId: "t1",
        }),
        parentProjectionUserIds: ["parent_viewer"],
      }),
      await deriveCommunityDeliveryOperationId("msg_1"),
    )
  })

  it("enqueues the exact mobile-push union separately from gated bot wakes", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "u_all", "bot_1"])
    mockListAttention.mockResolvedValue([{ userId: "bot_1", kind: "mention" }])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["u_all", state()],
      ["bot_1", state({ hasAttention: true })],
    ]))
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "bot_1",
      name: "Bot",
      discriminator: "0001",
      instruction: "Own support triage",
      machineId: "m1",
      runtime: "codex",
    }])

    await dispatchCommittedMessage({} as never, "msg_1")

    expect(mockEnqueueQueueTasks).toHaveBeenNthCalledWith(1, [
      { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "u_all" },
      { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "bot_1" },
    ])
    expect(mockEnqueueQueueTasks).toHaveBeenNthCalledWith(2, [
      { version: 1, kind: "bot-wake", messageId: "msg_1", botUserId: "bot_1" },
    ])
  })

  it("does not reject the committed mutation when planning or transport fails", async () => {
    mockGetMessage.mockRejectedValueOnce(new Error("D1 unavailable"))
    await expect(dispatchCommittedMessage({} as never, "msg_1")).resolves.toBeUndefined()

    mockGetMessage.mockResolvedValue(message)
    mockSendMessageDeliveryBatch.mockRejectedValueOnce(new Error("ws unavailable"))
    await expect(dispatchCommittedMessage({} as never, "msg_1")).resolves.toBeUndefined()
  })

  it("logs a queue rejection while preserving fail-open dispatch", async () => {
    mockEnqueueQueueTasks.mockRejectedValueOnce(new Error("queue unavailable"))

    await expect(dispatchCommittedMessage({} as never, "msg_1")).resolves.toBeUndefined()

    expect(mockLogWarn).toHaveBeenCalledWith("committed_message_push_queue_delivery_failed", {
      messageId: "msg_1",
      err: "Error: queue unavailable",
    })
  })

  it("logs a bot-wake queue rejection while preserving fail-open dispatch", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "bot_1"])
    mockResolveEligibility.mockResolvedValue(new Map([["bot_1", state()]]))
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "bot_1",
      name: "Bot",
      discriminator: "0001",
      instruction: "",
      machineId: "m1",
      runtime: "codex",
    }])
    mockEnqueueQueueTasks
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("wake queue unavailable"))

    await expect(dispatchCommittedMessage({} as never, "msg_1")).resolves.toBeUndefined()

    expect(mockLogWarn).toHaveBeenCalledWith("committed_message_wake_queue_delivery_failed", {
      messageId: "msg_1",
      err: "Error: wake queue unavailable",
    })
  })

  it("enqueues deterministic candidates when the gate unexpectedly rejects", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "bot_1"])
    mockResolveEligibility.mockResolvedValue(new Map([["bot_1", state()]]))
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "bot_1",
      name: "Bot",
      discriminator: "0001",
      instruction: "",
      machineId: "m1",
      runtime: "codex",
    }])
    mockSelectJevWakeCandidates.mockRejectedValue(new Error("unexpected"))

    await dispatchCommittedMessage({} as never, "msg_1")

    expect(mockEnqueueQueueTasks).toHaveBeenCalledWith([
      { version: 1, kind: "bot-wake", messageId: "msg_1", botUserId: "bot_1" },
    ])
    expect(mockLogWarn).toHaveBeenCalledWith(
      "committed_message_jev_gate_failed_open",
      { messageId: "msg_1" },
    )
  })

  it("starts browser delivery and mobile push without waiting for JEV", async () => {
    let releaseGate!: (value: unknown[]) => void
    mockResolveRecipients.mockResolvedValue(["author_1", "u_all", "bot_1"])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["u_all", state()],
      ["bot_1", state()],
    ]))
    mockFindWakeCandidates.mockResolvedValue([{
      botUserId: "bot_1",
      name: "Bot",
      discriminator: "0001",
      instruction: "",
      machineId: "m1",
      runtime: "codex",
    }])
    mockSelectJevWakeCandidates.mockReturnValue(new Promise((resolve) => {
      releaseGate = resolve
    }))

    const work = dispatchCommittedMessage({} as never, "msg_1")
    await vi.waitFor(() => {
      expect(mockSendMessageDeliveryBatch).toHaveBeenCalledOnce()
      expect(mockEnqueueQueueTasks).toHaveBeenCalledWith([
        { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "u_all" },
        { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "bot_1" },
      ])
    })
    expect(mockEnqueueQueueTasks).toHaveBeenCalledTimes(1)

    releaseGate([])
    await work
    expect(mockEnqueueQueueTasks).toHaveBeenNthCalledWith(2, [])
  })
})
