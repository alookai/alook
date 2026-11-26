import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, communityReadSchemas } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  threadsParseCalls: 0,
}))

vi.mock("@/lib/api/client", async (original) => {
  const actual = await original<typeof import("@/lib/api/client")>()
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
  }
})

vi.mock("@alook/shared", async (original) => {
  const actual = await original<typeof import("@alook/shared")>()
  return {
    ...actual,
    communityReadSchemas: (...args: Parameters<typeof actual.communityReadSchemas>) => {
      const schemas = actual.communityReadSchemas(...args)
      return {
        ...schemas,
        threads: {
          ...schemas.threads,
          parse: (value: unknown) => {
            mocks.threadsParseCalls += 1
            return schemas.threads.parse(value)
          },
        },
      }
    },
  }
})

import { forumFeedPageQueryFn } from "@/hooks/community/use-forum-feed"
import { normalizeThreadResources } from "@/lib/community/forum-feed-window"
import { forumSidebarCandidates } from "@/lib/community/forum-sidebar"
import {
  canonicalChannelMembershipRow,
  canonicalChannelRow,
  type AttentionScopeRow,
  type ChannelRow,
  type MessageRow,
} from "@/lib/community-db/schema"
import { createCommunityQueryOwner } from "@/test/community-query-owner"

beforeEach(() => {
  mocks.apiFetch.mockReset()
  mocks.threadsParseCalls = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("versioned forum resource normalization", () => {
  it("preserves current resources, scopes and pagination", () => {
    const contractVersion = BUSINESS_SCHEMA_VERSION
    const channel = { id: "forum", type: "forum", serverId: "server", name: "Forum", topic: "Topic", categoryId: null,
      parentChannelId: null, parentMessageId: null, creatorId: "author", position: 0, archived: false, createdAt: "now", lastMessageAt: null, messageCount: 1 }
    const message = { id: "opener", channelId: "forum", seq: 1, authorId: "author", authorName: "Author", authorAvatarVersion: 0,
      type: "chat", content: "Title", replyToId: null, clientNonce: null, createdAt: "now", attachments: [] }
    const profile = { id: "author", name: "Author", discriminator: "1234", avatar: null, avatarVersion: 0 }
    const body = communityReadSchemas(contractVersion).threads.parse({ contractVersion, channelId: "forum", channel,
      threads: [{ ...channel, id: "thread", type: "thread", parentChannelId: "forum", parentMessageId: "opener" }],
      included: { messages: [message, { ...message, id: "reply", channelId: "thread", content: "Reply" }],
        profiles: [profile],
        members: [{ channelId: "thread", userId: "author", relation: "notify", source: "spoke", isCreator: true, role: null, memberId: null }], tags: [{ messageId: "opener", tag: "bug" }],
        participantCounts: [{ channelId: "thread", count: 1 }] }, page: { hasMore: true, nextCursor: "cursor" } })
    const result = normalizeThreadResources("forum", body)
    expect(result.channel).toEqual(channel)
    expect(result.threads).toEqual(body.threads)
    expect(result.included.messages).toEqual(body.included.messages)
    expect(result.included.profiles).toEqual([profile])
    expect(result.included.previews).toEqual([body.included.messages[1]])
    expect(result.included.members).toEqual(body.included.members)
    expect(result.page).toEqual(body.page)
    for (const version of [1, 2, 3]) expect(() => normalizeThreadResources("forum", { ...body, contractVersion: version })).toThrow()
    expect(() => normalizeThreadResources("forum", { ...body, threads: [{ ...body.threads[0], messageCount: -1 }] } as never)).toThrow()
  })

  it("parses forum threads schema once per page across forumFeedPageQueryFn and publishCommunityForumFeed", async () => {
    const { client } = await createCommunityQueryOwner("viewer")
    const forumChannel = {
      id: "ch-forum",
      type: "forum" as const,
      serverId: "srv-1",
      name: "Forum",
      topic: "Topic",
      categoryId: null,
      parentChannelId: null,
      parentMessageId: null,
      creatorId: "u-0",
      position: 0,
      archived: false,
      createdAt: "2026-11-26T00:00:00.000Z",
      lastMessageAt: "2026-11-26T00:00:50.000Z",
      messageCount: 50,
    }
    const threads = Array.from({ length: 50 }, (_, i) => ({
      ...forumChannel,
      id: `th-${i}`,
      type: "thread" as const,
      name: `Post ${i}`,
      parentChannelId: "ch-forum",
      parentMessageId: `opener-${i}`,
      messageCount: 2,
    }))
    const messages = threads.flatMap((t, i) => [
      {
        id: `opener-${i}`,
        channelId: "ch-forum",
        seq: i + 1,
        authorId: `u-${i}`,
        authorName: `User${i}`,
        authorAvatarVersion: 0,
        type: "chat" as const,
        content: `Post title ${i}`,
        replyToId: null,
        clientNonce: null,
        createdAt: "2026-11-26T00:00:00.000Z",
        attachments: [],
      },
      {
        id: `first-${i}`,
        channelId: t.id,
        seq: 1,
        authorId: `u-${i}`,
        authorName: `User${i}`,
        authorAvatarVersion: 0,
        type: "chat" as const,
        content: `Post body ${i}`,
        replyToId: null,
        clientNonce: null,
        createdAt: "2026-11-26T00:00:01.000Z",
        attachments: [],
      },
    ])
    const profiles = Array.from({ length: 50 }, (_, i) => ({
      id: `u-${i}`,
      name: `User${i}`,
      discriminator: String(i).padStart(4, "0"),
      avatar: null,
      avatarVersion: 0,
    }))
    const members = threads.map((t, i) => ({
      channelId: t.id,
      userId: `u-${i}`,
      relation: "notify" as const,
      source: "spoke" as const,
      isCreator: true,
      role: "member" as const,
      memberId: `mem-${i}`,
    }))
    const tags = threads.map((_t, i) => ({ messageId: `opener-${i}`, tag: `tag-${i % 5}` }))
    const participantCounts = threads.map((t) => ({ channelId: t.id, count: 1 }))

    mocks.apiFetch.mockResolvedValueOnce({
      contractVersion: BUSINESS_SCHEMA_VERSION,
      channelId: "ch-forum",
      channel: forumChannel,
      threads,
      included: { messages, profiles, members, tags, participantCounts },
      page: { hasMore: false, nextCursor: null },
    })

    const queryFn = forumFeedPageQueryFn("ch-forum", null, client)
    const page = await queryFn({ pageParam: null })

    expect(page.threads).toHaveLength(50)
    expect(mocks.threadsParseCalls).toBe(1)
  })

  it("matches forum sidebar unread candidates without quadratic attention scans", () => {
    const forumChannels: ChannelRow[] = [
      canonicalChannelRow({
        id: "forum-1",
        serverId: "s1",
        categoryId: null,
        parentChannelId: null,
        parentMessageId: null,
        name: "forum",
        topic: "",
        type: "forum",
        position: 0,
        muted: false,
        archived: false,
        tags: [],
        messageCount: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastMessageAt: "2026-01-01T00:00:00.000Z",
        creatorId: null,
      }),
      ...Array.from({ length: 500 }, (_, i) =>
        canonicalChannelRow({
          id: `t-${i}`,
          serverId: "s1",
          categoryId: null,
          parentChannelId: "forum-1",
          parentMessageId: `m-${i}`,
          name: `thread-${i}`,
          topic: "",
          type: "thread",
          position: i,
          muted: false,
          archived: false,
          tags: [],
          messageCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastMessageAt: "2026-11-26T00:00:00.000Z",
          creatorId: null,
        }),
      ),
    ]
    const forumMemberships = Array.from({ length: 500 }, (_, i) =>
      canonicalChannelMembershipRow(`t-${i}`, "viewer", "notify", { source: "explicit" }),
    )
    const forumMessages: MessageRow[] = Array.from({ length: 500 }, (_, i) => ({
      id: `m-${i}`,
      channelId: "forum-1",
      seq: i + 1,
      authorId: "viewer",
      content: `Post ${i}`,
      createdAt: "2026-11-26T00:00:00.000Z",
      editedAt: null,
      deletedAt: null,
      pinned: false,
      replyToId: null,
      replyTo: null,
      threadId: `t-${i}`,
      reactions: [],
      attachments: [],
      embeds: [],
      interactive: null,
      pending: false,
    })) as unknown as MessageRow[]
    const forumAttention: AttentionScopeRow[] = Array.from({ length: 500 }, (_, i) => ({
      scopeId: `other-${i}`,
      channelId: `other-${i}`,
      serverId: "s1",
      parentChannelId: null,
      ordinaryUnread: true,
      lastUnreadSeq: 1,
      lastAttentionSeq: null,
      attentionCount: 0,
    }))
    const someSpy = vi.spyOn(Array.prototype, "some")
    const candidates = forumSidebarCandidates(forumChannels, forumMemberships, forumMessages, "viewer", "s1", forumAttention)
    expect(candidates).toHaveLength(500)
    expect(someSpy).not.toHaveBeenCalled()
  })
})
