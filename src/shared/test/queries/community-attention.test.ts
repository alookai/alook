import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  visible: vi.fn(),
  channels: vi.fn(),
  dms: vi.fn(),
  mentions: vi.fn(),
  mentionScopes: vi.fn(),
  friends: vi.fn(),
  channelOwners: vi.fn(),
  serverOwners: vi.fn(),
  forumOpeners: vi.fn(),
  threadOpeners: vi.fn(),
}))

vi.mock("../../src/db/queries/community/channel", () => ({
  listVisibleChannelIdsForUser: (...args: unknown[]) => mocks.visible(...args),
  getChannelsByIds: (...args: unknown[]) => mocks.channelOwners(...args),
}))
vi.mock("../../src/db/queries/community/inbox", () => ({
  listEligibleUnreadChannels: (...args: unknown[]) => mocks.channels(...args),
  listEligibleUnreadDms: (...args: unknown[]) => mocks.dms(...args),
  listUnreadForumOpeners: (...args: unknown[]) => mocks.forumOpeners(...args),
  listThreadOpenersByChildIds: (...args: unknown[]) => mocks.threadOpeners(...args),
}))
vi.mock("../../src/db/queries/community/mention", () => ({
  listUnreadMentions: (...args: unknown[]) => mocks.mentions(...args),
  listUnreadMentionScopes: (...args: unknown[]) => mocks.mentionScopes(...args),
}))
vi.mock("../../src/db/queries/community/friendship", () => ({
  listActionableIncomingRequests: (...args: unknown[]) => mocks.friends(...args),
}))
vi.mock("../../src/db/queries/community/server", () => ({
  getServersByIds: (...args: unknown[]) => mocks.serverOwners(...args),
}))

import { getAccountAttentionSnapshot } from "../../src/db/queries/community/attention"
import { AccountAttentionSnapshotSchema } from "../../src/community-attention"

describe("account attention snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.visible.mockResolvedValue(["c1"])
    mocks.channels.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      lastUnreadSeq: 9,
      lastAttentionSeq: 9,
      mentionCount: 9,
    }])
    mocks.dms.mockResolvedValue([])
    mocks.channelOwners.mockResolvedValue([{
      id: "c1",
      serverId: "s1",
      name: "general",
      type: "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: "owner",
      archived: 0,
      lastMessageAt: "2026-09-27T00:00:02.000Z",
    }])
    mocks.serverOwners.mockResolvedValue([{
      id: "s1",
      name: "One",
      discriminator: "0001",
    }])
    mocks.forumOpeners.mockResolvedValue([])
    mocks.threadOpeners.mockResolvedValue([])
    mocks.mentionScopes.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      attentionCount: 9,
      lastAttentionSeq: 9,
    }])
    mocks.mentions.mockResolvedValue(Array.from({ length: 3 }, (_, index) => ({
      mention: { id: `men${index}`, kind: "mention" },
      message: {
        id: `m${index}`,
        channelId: "c1",
        type: "chat",
        seq: 9 - index,
        createdAt: `2026-09-27T00:00:0${index}.000Z`,
        content: `message ${index}`,
      },
      author: {
        id: `u${index}`,
        name: `User ${index}`,
        discriminator: `000${index}`,
        image: null,
        avatarVersion: 1,
      },
    })))
    mocks.friends.mockResolvedValue(Array.from({ length: 3 }, (_, index) => ({
      id: `f${index}`,
      userId: `friend${index}`,
      name: `Friend ${index}`,
      discriminator: `100${index}`,
      image: null,
      avatarVersion: 1,
      createdAt: `2026-09-27T00:01:0${index}.000Z`,
    })))
  })

  it("caps only mention rows while keeping exact scope counts and every friend request", async () => {
    const snapshot = await getAccountAttentionSnapshot({} as never, "viewer", 2)

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.scopes[0]?.attentionCount).toBe(9)
    expect(snapshot.items.filter((item) => item.kind !== "friend_request")).toHaveLength(2)
    expect(snapshot.items.filter((item) => item.kind === "friend_request")).toHaveLength(3)
    expect(snapshot.included?.profiles).toHaveLength(5)
    expect(mocks.mentions).toHaveBeenCalledWith(
      {},
      "viewer",
      { limit: 3, visibleChannelIds: ["c1"] },
    )
  })

  it("keeps an attention-only scope after its ordinary unread cursor advances", async () => {
    mocks.visible.mockResolvedValue(["c1"])
    mocks.channels.mockResolvedValue([])
    mocks.mentionScopes.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: "forum1",
      attentionCount: 3,
      lastAttentionSeq: 7,
    }])
    mocks.channelOwners.mockResolvedValue([{
      id: "c1",
      serverId: "s1",
      name: "Post",
      type: "thread",
      parentChannelId: "forum1",
      parentMessageId: "opener1",
      creatorId: "owner",
      archived: 0,
      lastMessageAt: "2026-09-27T00:00:02.000Z",
    }, {
      id: "forum1",
      serverId: "s1",
      name: "Ideas",
      type: "forum",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: "owner",
      archived: 0,
      lastMessageAt: "2026-09-27T00:00:00.000Z",
    }])
    mocks.threadOpeners.mockResolvedValue([{
      parentChannelId: "forum1",
      parentType: "forum",
      openerMessageId: "opener1",
      childChannelId: "c1",
      title: "Post",
      createdAt: "2026-09-27T00:00:00.000Z",
      openerSeq: 1,
      openerUnread: false,
    }])
    const snapshot = await getAccountAttentionSnapshot({} as never, "viewer", 2)

    expect(snapshot.scopes).toEqual([{
      scopeId: "c1",
      channelId: "c1",
      serverId: "s1",
      parentChannelId: "forum1",
      ordinaryUnread: false,
      lastUnreadSeq: 7,
      lastAttentionSeq: 7,
      attentionCount: 3,
    }])
    expect(mocks.mentions).toHaveBeenCalledWith(
      {},
      "viewer",
      { limit: 3, visibleChannelIds: ["c1"] },
    )
  })

  it("drops a raced-in item whose aggregate scope is not present", async () => {
    mocks.channels.mockResolvedValue([])
    mocks.mentionScopes.mockResolvedValue([])

    const snapshot = await getAccountAttentionSnapshot({} as never, "viewer", 2)

    expect(snapshot.scopes).toEqual([])
    expect(snapshot.items.filter((item) => item.kind !== "friend_request")).toEqual([])
    expect(snapshot.truncated).toBe(false)
    expect(() => AccountAttentionSnapshotSchema.parse(snapshot)).not.toThrow()
  })

  it("keeps a raced aggregate scope without requiring a bounded item row", async () => {
    mocks.channels.mockResolvedValue([])
    mocks.mentionScopes.mockResolvedValue([{
      channelId: "c1",
      serverId: "s1",
      parentChannelId: null,
      attentionCount: 3,
      lastAttentionSeq: 9,
    }])
    mocks.mentions.mockResolvedValue([])

    const snapshot = await getAccountAttentionSnapshot({} as never, "viewer", 2)

    expect(snapshot.scopes).toEqual([expect.objectContaining({
      scopeId: "c1",
      ordinaryUnread: false,
      attentionCount: 3,
    })])
    expect(snapshot.items.filter((item) => item.kind !== "friend_request")).toEqual([])
    expect(snapshot.truncated).toBe(true)
    expect(() => AccountAttentionSnapshotSchema.parse(snapshot)).not.toThrow()
  })

  it("emits one explicit presentation unit for each unread forum opener", async () => {
    mocks.channels.mockResolvedValue([{
      channelId: "forum1",
      channelName: "Ideas",
      serverId: "s1",
      serverName: "One",
      type: "forum",
      parentChannelId: null,
      lastMessageAt: "2026-09-27T00:00:02.000Z",
      lastUnreadSeq: 2,
      lastAttentionSeq: null,
      mentionCount: 0,
    }])
    mocks.mentionScopes.mockResolvedValue([])
    mocks.mentions.mockResolvedValue([])
    mocks.friends.mockResolvedValue([])
    mocks.forumOpeners.mockResolvedValue([1, 2].map((seq) => ({
      forumChannelId: "forum1",
      openerMessageId: `opener${seq}`,
      childChannelId: `post${seq}`,
      title: `Post ${seq}`,
      createdAt: `2026-09-27T00:00:0${seq}.000Z`,
      openerSeq: seq,
    })))
    mocks.channelOwners.mockResolvedValue([{
      id: "forum1",
      serverId: "s1",
      name: "Ideas",
      type: "forum",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: "owner",
      archived: 0,
      lastMessageAt: "2026-09-27T00:00:02.000Z",
    }, ...[1, 2].map((seq) => ({
      id: `post${seq}`,
      serverId: "s1",
      name: `Post ${seq}`,
      type: "thread",
      parentChannelId: "forum1",
      parentMessageId: `opener${seq}`,
      creatorId: "owner",
      archived: 0,
      lastMessageAt: `2026-09-27T00:00:0${seq}.000Z`,
    }))])

    const snapshot = await getAccountAttentionSnapshot({} as never, "viewer", 100)
    const posts = snapshot.items.filter((entry) => entry.kind === "forum_post")

    expect(posts).toEqual([
      expect.objectContaining({ sourceId: "post2", openerSeq: 2 }),
      expect.objectContaining({ sourceId: "post1", openerSeq: 1 }),
    ])
    expect(snapshot.items.filter((entry) => entry.kind === "mention")).toEqual([])
    expect(() => AccountAttentionSnapshotSchema.parse(snapshot)).not.toThrow()
  })
})
