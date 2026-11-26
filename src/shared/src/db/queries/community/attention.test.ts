import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listVisibleChannelIdsForUser: vi.fn(),
  listEligibleUnreadChannels: vi.fn(),
  listEligibleUnreadDms: vi.fn(),
  listPendingQuestionMessages: vi.fn(),
  listReadableDmChannelIds: vi.fn(),
  listReadableDmSummariesByChannelIds: vi.fn(),
  listActionableIncomingRequests: vi.fn(),
  listUnreadMentionScopes: vi.fn(),
  listUnreadMentions: vi.fn(),
  getChannelsByIds: vi.fn(),
  getServersByIds: vi.fn(),
  listUnreadForumOpeners: vi.fn(),
  listThreadOpenersByChildIds: vi.fn(),
  loadUserNotificationSettingLookup: vi.fn(),
}))

vi.mock("./channel", () => ({
  listVisibleChannelIdsForUser: mocks.listVisibleChannelIdsForUser,
  getChannelsByIds: mocks.getChannelsByIds,
}))
vi.mock("./inbox", () => ({
  listEligibleUnreadChannels: mocks.listEligibleUnreadChannels,
  listEligibleUnreadDms: mocks.listEligibleUnreadDms,
  listPendingQuestionMessages: mocks.listPendingQuestionMessages,
  listReadableDmChannelIds: mocks.listReadableDmChannelIds,
  listReadableDmSummariesByChannelIds: mocks.listReadableDmSummariesByChannelIds,
  listUnreadForumOpeners: mocks.listUnreadForumOpeners,
  listThreadOpenersByChildIds: mocks.listThreadOpenersByChildIds,
}))
vi.mock("./notification-eligibility", () => ({
  loadUserNotificationSettingLookup: mocks.loadUserNotificationSettingLookup,
}))
vi.mock("./friendship", () => ({
  listActionableIncomingRequests: mocks.listActionableIncomingRequests,
}))
vi.mock("./mention", () => ({
  listUnreadMentionScopes: mocks.listUnreadMentionScopes,
  listUnreadMentions: mocks.listUnreadMentions,
}))
vi.mock("./server", () => ({ getServersByIds: mocks.getServersByIds }))

import { DEFAULT_ATTENTION_ITEM_LIMIT, getAccountAttentionProjection } from "./attention"
import { buildDecisionCardEmbed, DecisionCardInputSchema } from "../../../community-decision-card"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listVisibleChannelIdsForUser.mockResolvedValue([])
  mocks.listEligibleUnreadChannels.mockResolvedValue([])
  mocks.listEligibleUnreadDms.mockResolvedValue([{
    channelId: "dm_1",
    otherUserId: "user_2",
    otherUserName: "Peer",
    otherUserDiscriminator: "0002",
    otherUserImage: null,
    otherUserAvatarVersion: 1,
    lastMessageAt: "2026-09-27T00:00:00.000Z",
    lastUnreadSeq: 4,
    unreadCount: 2,
  }])
  mocks.listActionableIncomingRequests.mockResolvedValue([])
  mocks.listUnreadMentionScopes.mockResolvedValue([])
  mocks.listUnreadMentions.mockResolvedValue([])
  mocks.getChannelsByIds.mockResolvedValue([])
  mocks.getServersByIds.mockResolvedValue([])
  mocks.listUnreadForumOpeners.mockResolvedValue([])
  mocks.listThreadOpenersByChildIds.mockResolvedValue([])
  mocks.listPendingQuestionMessages.mockResolvedValue([])
  mocks.listReadableDmChannelIds.mockResolvedValue(["dm_1"])
  mocks.listReadableDmSummariesByChannelIds.mockResolvedValue([])
  mocks.loadUserNotificationSettingLookup.mockResolvedValue({ byChannelId: new Map(), byServerId: new Map() })
})

describe("getAccountAttentionProjection", () => {
  it("uses the default limit and projects ordinary DM unread scopes", async () => {
    const snapshot = await getAccountAttentionProjection({} as never, "user_1")

    expect(snapshot.limit).toBe(DEFAULT_ATTENTION_ITEM_LIMIT)
    expect(snapshot.scopes).toEqual([{
      scopeId: "dm_1",
      channelId: "dm_1",
      serverId: null,
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
      unreadCount: 2,
      lastAttentionSeq: null,
      attentionCount: 0,
    }])
    expect(snapshot.included.dms).toEqual([expect.objectContaining({
      id: "dm_1",
      userId: "user_2",
    })])
  })

  it("skips channel rows that cannot become canonical owners", async () => {
    mocks.listEligibleUnreadDms.mockResolvedValue([])
    mocks.listEligibleUnreadChannels.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      type: "text",
      lastUnreadSeq: 4,
    }])
    mocks.getChannelsByIds.mockResolvedValue([{
      id: "c1",
      serverId: "s1",
      name: null,
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
    }])
    mocks.getServersByIds.mockResolvedValue([{
      id: "s1", name: "Server", discriminator: "0001",
    }])

    const snapshot = await getAccountAttentionProjection({} as never, "user_1")

    expect(snapshot.included.channels).toEqual([])
    expect(snapshot.scopes).toEqual([])
  })

  it("drops a scope whose canonical channel belongs to another server", async () => {
    mocks.listEligibleUnreadDms.mockResolvedValue([])
    mocks.listEligibleUnreadChannels.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      type: "text",
      lastUnreadSeq: 4,
    }])
    mocks.getChannelsByIds.mockResolvedValue([{
      id: "c1",
      serverId: "s2",
      name: "General",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: null,
    }])
    mocks.getServersByIds.mockResolvedValue([{
      id: "s2", name: "Other", discriminator: "0002",
    }])

    const snapshot = await getAccountAttentionProjection({} as never, "user_1")

    expect(snapshot.included.channels).toHaveLength(1)
    expect(snapshot.scopes).toEqual([])
  })

  it("drops a forum presentation whose child does not own the opener", async () => {
    mocks.listEligibleUnreadDms.mockResolvedValue([])
    mocks.listEligibleUnreadChannels.mockResolvedValue([{
      channelId: "forum",
      serverId: "s1",
      parentChannelId: null,
      type: "forum",
      lastUnreadSeq: 7,
    }])
    mocks.listUnreadForumOpeners.mockResolvedValue([{
      forumChannelId: "forum",
      openerMessageId: "opener",
      childChannelId: "post",
      title: "Launch",
      createdAt: "2026-09-27T00:00:00.000Z",
      openerSeq: 7,
    }])
    mocks.getChannelsByIds.mockResolvedValue([{
      id: "forum",
      serverId: "s1",
      name: "Ideas",
      type: "forum",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: null,
    }, {
      id: "post",
      serverId: "s1",
      name: "Launch",
      type: "thread",
      parentChannelId: "forum",
      parentMessageId: "different-opener",
      creatorId: null,
      archived: false,
      lastMessageAt: null,
    }])
    mocks.getServersByIds.mockResolvedValue([{
      id: "s1", name: "Server", discriminator: "0001",
    }])

    const snapshot = await getAccountAttentionProjection({} as never, "user_1")

    expect(snapshot.scopes).toHaveLength(1)
    expect(snapshot.items.filter((item) => item.kind === "forum_post")).toEqual([])
  })

  const makeCardEmbeds = (assignees: Array<{ userId: string; handle: string }>) => JSON.stringify([
    buildDecisionCardEmbed(
      DecisionCardInputSchema.parse({
        summary: "Choose when we should ship the release.",
        questions: [{
          id: "q1",
          question: "When should we ship?",
          multiSelect: false,
          allowOther: false,
          options: [
            { id: "o1", label: "Today" },
            { id: "o2", label: "Tomorrow" },
          ],
        }],
      }),
      assignees,
    ),
  ])

  it("projects assigned server questions and DM questions even when read, while excluding unassigned server polls and other-assignee cards", async () => {
    mocks.listVisibleChannelIdsForUser.mockResolvedValue(["c1"])
    mocks.listEligibleUnreadDms.mockResolvedValue([])
    mocks.listReadableDmChannelIds.mockResolvedValue(["dm_1"])
    mocks.listReadableDmSummariesByChannelIds.mockResolvedValue([{
      channelId: "dm_1",
      otherUserId: "user_2",
      otherUserName: "Peer",
      otherUserDiscriminator: "0002",
      otherUserImage: null,
      otherUserAvatarVersion: 1,
      lastMessageAt: "2026-09-27T00:00:00.000Z",
    }])
    mocks.getChannelsByIds.mockResolvedValue([{
      id: "c1",
      serverId: "s1",
      name: "general",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: "2026-09-27T00:00:00.000Z",
    }])
    mocks.getServersByIds.mockResolvedValue([{
      id: "s1",
      name: "Server",
      discriminator: "0001",
    }])
    mocks.listPendingQuestionMessages.mockResolvedValue([
      {
        id: "q_dm",
        channelId: "dm_1",
        seq: 4,
        content: "Pick launch window",
        embeds: makeCardEmbeds([{ userId: "user_1", handle: "gus#1813" }]),
        createdAt: "2026-09-27T00:00:00.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
      {
        id: "q_chan_mine",
        channelId: "c1",
        seq: 5,
        content: "Assigned in read channel",
        embeds: makeCardEmbeds([{ userId: "user_1", handle: "gus#1813" }]),
        createdAt: "2026-09-26T23:59:30.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
      {
        id: "q_chan_open",
        channelId: "c1",
        seq: 3,
        content: "Unassigned channel poll",
        embeds: makeCardEmbeds([]),
        createdAt: "2026-09-26T23:59:00.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
      {
        id: "q_other",
        channelId: "c1",
        seq: 2,
        content: "For someone else",
        embeds: makeCardEmbeds([{ userId: "user_99", handle: "other#9999" }]),
        createdAt: "2026-09-26T23:58:00.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
    ])

    const snapshot = await getAccountAttentionProjection({} as never, "user_1")
    const questions = snapshot.items.filter((item) => item.kind === "question")

    expect(snapshot.scopes).toEqual([])
    expect(questions.map((item) => item.messageId)).toEqual(["q_dm", "q_chan_mine"])
    expect(snapshot.included.messages.filter((message) => message.type === "question").map((m) => m.id)).toEqual([
      "q_dm",
      "q_chan_mine",
    ])
    expect(snapshot.included.dms.map((dm) => dm.id)).toEqual(["dm_1"])
  })

  it("caps pending Todo question items and downstream hydration to todoLimit and marks truncated", async () => {
    mocks.listVisibleChannelIdsForUser.mockResolvedValue(["c1", "c2", "c3"])
    mocks.listReadableDmChannelIds.mockResolvedValue([])
    mocks.listEligibleUnreadChannels.mockResolvedValue([])
    mocks.listEligibleUnreadDms.mockResolvedValue([])
    mocks.listActionableIncomingRequests.mockResolvedValue([])
    mocks.listUnreadMentionScopes.mockResolvedValue([])
    mocks.listUnreadMentions.mockResolvedValue([])
    mocks.listReadableDmSummariesByChannelIds.mockResolvedValue([])
    mocks.getChannelsByIds.mockImplementation(async (_db: unknown, ids: string[]) => ids.map((id) => ({
      id,
      serverId: "s1",
      name: id,
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      archived: false,
      lastMessageAt: "2026-09-27T00:00:00.000Z",
    })))
    mocks.getServersByIds.mockResolvedValue([{ id: "s1", name: "Server", discriminator: "0001" }])
    mocks.listPendingQuestionMessages.mockResolvedValue([
      {
        id: "q3",
        channelId: "c3",
        seq: 3,
        content: "Third",
        embeds: makeCardEmbeds([{ userId: "user_1", handle: "gus#1813" }]),
        createdAt: "2026-09-27T00:00:03.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
      {
        id: "q2",
        channelId: "c2",
        seq: 2,
        content: "Second",
        embeds: makeCardEmbeds([{ userId: "user_1", handle: "gus#1813" }]),
        createdAt: "2026-09-27T00:00:02.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
      {
        id: "q1",
        channelId: "c1",
        seq: 1,
        content: "First",
        embeds: makeCardEmbeds([{ userId: "user_1", handle: "gus#1813" }]),
        createdAt: "2026-09-27T00:00:01.000Z",
        authorId: "user_2",
        authorName: "Peer",
        authorDiscriminator: "0002",
        authorImage: null,
        authorAvatarVersion: 1,
      },
    ])

    const snapshot = await getAccountAttentionProjection({} as never, "user_1", 2)

    expect(mocks.listPendingQuestionMessages).toHaveBeenCalledWith(
      {},
      "user_1",
      ["c1", "c2", "c3"],
      [],
      { limit: 3 },
    )
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.todosTruncated).toBe(true)
    expect(snapshot.items.filter((item) => item.kind === "question").map((item) => item.messageId)).toEqual(["q3", "q2"])
    expect(snapshot.included.messages.map((message) => message.id)).toEqual(["q3", "q2"])
    expect(snapshot.included.channels.map((channel) => channel.id)).toEqual(["c3", "c2"])
    expect(mocks.getChannelsByIds).toHaveBeenCalledWith({}, ["c3", "c2"])
  })
})
