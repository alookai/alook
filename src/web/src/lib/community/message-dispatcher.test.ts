import { beforeEach, describe, expect, it, vi } from "vitest"

const mockWaitUntil = vi.fn()
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({ ctx: { waitUntil: mockWaitUntil } }),
}))

const mockGetMessage = vi.fn()
const mockGetMessageInScope = vi.fn()
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
        getMessageInScope: (...args: unknown[]) => mockGetMessageInScope(...args),
        getMessageClientNonceForDelivery: (...args: unknown[]) =>
          mockGetMessageClientNonceForDelivery(...args),
      },
      communityChannel: {
        getChannel: (...args: unknown[]) => mockGetChannel(...args),
      },
      communityMention: {
        listMessageMentionUserIds: (...args: unknown[]) => mockListAttention(...args),
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
    mockGetMessageInScope.mockResolvedValue(null)
    mockGetMessageClientNonceForDelivery.mockResolvedValue("nonce_1")
    mockGetChannel.mockResolvedValue(channel)
    mockListAttachments.mockResolvedValue([])
    mockListAttention.mockResolvedValue(["u_mentions", "u_mention_only", "bot_1"])
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
      { botUserId: "bot_1", name: "Bot", machineId: "m1", runtime: "codex" },
    ])
    mockSendMessageDeliveryBatch.mockResolvedValue(undefined)
    mockEnqueueQueueTasks.mockResolvedValue(undefined)
  })

  it("derives content, notification, mention, and bot targets from one D1 plan", async () => {
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "u_all", "u_mentions", "bot_1"])
    expect(plan.unreadPlainUserIds).toEqual(["u_all"])
    expect(plan.unreadMentionUserIds).toEqual(["u_mentions", "bot_1"])
    expect(plan.mentionUserIds).toEqual(["u_mentions", "u_mention_only", "bot_1"])
    expect(plan.wakeBotUserIds).toEqual(["bot_1"])
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

  it("delivers content to passive readers without adding unread, mention, or wake candidates", async () => {
    mockGetChannel.mockResolvedValue({ ...channel, type: "thread", parentChannelId: "parent" })
    mockResolveRecipients.mockResolvedValue(["author_1", "reader", "passive_bot", "u_all"])
    mockResolveNotificationRecipients.mockResolvedValue(["author_1", "u_all"])
    mockListAttention.mockResolvedValue([])
    mockResolveEligibility.mockResolvedValue(new Map([["u_all", state()]]))
    mockFindWakeCandidates.mockResolvedValue([{ botUserId: "passive_bot" }])
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
  })

  it("rehydrates attachment dimensions and reply preview from committed rows", async () => {
    mockGetMessage.mockResolvedValue({ ...message, replyToId: "reply_1" })
    mockGetMessageInScope.mockResolvedValue({
      id: "reply_1",
      authorName: "Earlier",
      content: "previous message",
    })
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

  it("keeps forum-thread participants, mention-only attention, and parent access distinct", async () => {
    mockGetMessage.mockResolvedValue({ ...message, channelId: "t1" })
    mockGetChannel.mockResolvedValue({
      ...channel,
      id: "t1",
      type: "thread",
      parentChannelId: "forum_1",
      messageCount: 3,
    })
    mockListAttention.mockResolvedValue(["parent_viewer"])
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
    mockListAttention.mockResolvedValue(["author_1"])
    mockResolveRecipients.mockResolvedValue(["author_1"])
    mockResolveEligibility.mockResolvedValue(new Map([["author_1", state({ hasAttention: true })]]))
    mockFindWakeCandidates.mockResolvedValue([
      { botUserId: "author_1", name: "Author Bot", machineId: "m1", runtime: "codex" },
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
    mockResolveRecipients.mockResolvedValue(["author_1", "reader", "u_all", "u_mentions"])
    mockResolveNotificationRecipients.mockResolvedValue(["author_1", "u_all", "u_all", "u_mentions", "outside"])
    mockListAttention.mockResolvedValue(["author_1", "u_mentions", "u_mentions", "u_mention_only"])
    const plan = await planCommittedMessage({} as never, "msg_1")
    expect(mockResolveEligibility).toHaveBeenCalledWith({}, ["u_all", "u_mentions", "outside", "u_mention_only"], "msg_1")
    expect(plan.contentUserIds).toEqual(["author_1", "reader", "u_all", "u_mentions"])
    expect(plan.unreadPlainUserIds).toEqual(["u_all"])
    expect(plan.unreadMentionUserIds).toEqual(["u_mentions"])
    expect(plan.mentionUserIds).toEqual(["u_mentions", "u_mention_only"])
    expect(plan.pushUserIds).toEqual(["u_all", "u_mentions", "u_mention_only"])
    expect(plan.wakeBotUserIds).toEqual([])
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
    mockGetMessageClientNonceForDelivery.mockResolvedValue("nonce_1")
    mockListAttachments.mockResolvedValue([])
    mockListAttention.mockResolvedValue([])
    mockResolveRecipients.mockResolvedValue(["author_1"])
    mockResolveNotificationRecipients.mockImplementation(
      (db, id, run) => run("thread-participants", () => mockResolveRecipients(db, id)),
    )
    mockResolveEligibility.mockResolvedValue(new Map())
    mockFindWakeCandidates.mockResolvedValue([])
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

  it("enqueues bot wake before the exact three-list mobile push union", async () => {
    mockResolveRecipients.mockResolvedValue(["author_1", "u_all", "bot_1"])
    mockListAttention.mockResolvedValue(["bot_1"])
    mockResolveEligibility.mockResolvedValue(new Map([
      ["u_all", state()],
      ["bot_1", state({ hasAttention: true })],
    ]))
    mockFindWakeCandidates.mockResolvedValue([{ botUserId: "bot_1" }])

    await dispatchCommittedMessage({} as never, "msg_1")

    expect(mockEnqueueQueueTasks).toHaveBeenCalledWith([
      { version: 1, kind: "bot-wake", messageId: "msg_1", botUserId: "bot_1" },
      { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "u_all" },
      { version: 1, kind: "mobile-push", messageId: "msg_1", userId: "bot_1" },
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

    expect(mockLogWarn).toHaveBeenCalledWith("committed_message_queue_delivery_failed", {
      messageId: "msg_1",
      err: "Error: queue unavailable",
    })
  })
})
