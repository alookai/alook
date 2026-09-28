import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listVisibleChannelIdsForUser: vi.fn(),
  listEligibleUnreadChannels: vi.fn(),
  listEligibleUnreadDms: vi.fn(),
  listActionableIncomingRequests: vi.fn(),
  listUnreadMentionScopes: vi.fn(),
  listUnreadMentions: vi.fn(),
  getChannelsByIds: vi.fn(),
  getServersByIds: vi.fn(),
  listUnreadForumOpeners: vi.fn(),
  listThreadOpenersByChildIds: vi.fn(),
}))

vi.mock("./channel", () => ({
  listVisibleChannelIdsForUser: mocks.listVisibleChannelIdsForUser,
  getChannelsByIds: mocks.getChannelsByIds,
}))
vi.mock("./inbox", () => ({
  listEligibleUnreadChannels: mocks.listEligibleUnreadChannels,
  listEligibleUnreadDms: mocks.listEligibleUnreadDms,
  listUnreadForumOpeners: mocks.listUnreadForumOpeners,
  listThreadOpenersByChildIds: mocks.listThreadOpenersByChildIds,
}))
vi.mock("./friendship", () => ({
  listActionableIncomingRequests: mocks.listActionableIncomingRequests,
}))
vi.mock("./mention", () => ({
  listUnreadMentionScopes: mocks.listUnreadMentionScopes,
  listUnreadMentions: mocks.listUnreadMentions,
}))
vi.mock("./server", () => ({ getServersByIds: mocks.getServersByIds }))

import { DEFAULT_ATTENTION_ITEM_LIMIT, getAccountAttentionSnapshot } from "./attention"

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
  }])
  mocks.listActionableIncomingRequests.mockResolvedValue([])
  mocks.listUnreadMentionScopes.mockResolvedValue([])
  mocks.listUnreadMentions.mockResolvedValue([])
  mocks.getChannelsByIds.mockResolvedValue([])
  mocks.getServersByIds.mockResolvedValue([])
  mocks.listUnreadForumOpeners.mockResolvedValue([])
  mocks.listThreadOpenersByChildIds.mockResolvedValue([])
})

describe("getAccountAttentionSnapshot", () => {
  it("uses the default limit and projects ordinary DM unread scopes", async () => {
    const snapshot = await getAccountAttentionSnapshot({} as never, "user_1")

    expect(snapshot.limit).toBe(DEFAULT_ATTENTION_ITEM_LIMIT)
    expect(snapshot.scopes).toEqual([{
      scopeId: "dm_1",
      channelId: "dm_1",
      serverId: null,
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 4,
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

    const snapshot = await getAccountAttentionSnapshot({} as never, "user_1")

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

    const snapshot = await getAccountAttentionSnapshot({} as never, "user_1")

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

    const snapshot = await getAccountAttentionSnapshot({} as never, "user_1")

    expect(snapshot.scopes).toHaveLength(1)
    expect(snapshot.items.filter((item) => item.kind === "forum_post")).toEqual([])
  })
})
