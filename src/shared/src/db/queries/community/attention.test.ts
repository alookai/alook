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
})
