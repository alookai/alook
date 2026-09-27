import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listVisibleChannelIdsForUser: vi.fn(),
  listEligibleUnreadChannels: vi.fn(),
  listEligibleUnreadDms: vi.fn(),
  listActionableIncomingRequests: vi.fn(),
  listUnreadMentionScopes: vi.fn(),
  listUnreadMentions: vi.fn(),
}))

vi.mock("./channel", () => ({ listVisibleChannelIdsForUser: mocks.listVisibleChannelIdsForUser }))
vi.mock("./inbox", () => ({
  listEligibleUnreadChannels: mocks.listEligibleUnreadChannels,
  listEligibleUnreadDms: mocks.listEligibleUnreadDms,
}))
vi.mock("./friendship", () => ({
  listActionableIncomingRequests: mocks.listActionableIncomingRequests,
}))
vi.mock("./mention", () => ({
  listUnreadMentionScopes: mocks.listUnreadMentionScopes,
  listUnreadMentions: mocks.listUnreadMentions,
}))

import { DEFAULT_ATTENTION_ITEM_LIMIT, getAccountAttentionSnapshot } from "./attention"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listVisibleChannelIdsForUser.mockResolvedValue([])
  mocks.listEligibleUnreadChannels.mockResolvedValue([])
  mocks.listEligibleUnreadDms.mockResolvedValue([{ channelId: "dm_1", lastUnreadSeq: 4 }])
  mocks.listActionableIncomingRequests.mockResolvedValue([])
  mocks.listUnreadMentionScopes.mockResolvedValue([])
  mocks.listUnreadMentions.mockResolvedValue([])
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
  })
})
