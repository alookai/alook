import { describe, expect, it } from "vitest"
import { communityReadSchemas } from "@alook/shared"
import { normalizeThreadResources } from "./forum-feed-window"

describe("versioned forum resource normalization", () => {
  it.each([2, 3] as const)("preserves contract %s resources, scopes and pagination", (contractVersion) => {
    const channel = { id: "forum", type: "forum", serverId: "server", name: "Forum", topic: "Topic", categoryId: null,
      parentChannelId: null, parentMessageId: null, creatorId: "author", position: 0, archived: false, createdAt: "now", lastMessageAt: null, messageCount: 1 }
    const message = { id: "opener", channelId: "forum", seq: 1, authorId: "author", authorName: "Author", authorAvatarVersion: 0,
      type: "chat", content: "Title", replyToId: null, clientNonce: null, createdAt: "now", attachments: [] }
    const profile = { id: "author", name: "Author", discriminator: "1234", avatar: null, avatarVersion: 0 }
    const body = communityReadSchemas(contractVersion).threads.parse({ contractVersion, channelId: "forum", channel,
      threads: [{ ...channel, id: "thread", type: "thread", parentChannelId: "forum", parentMessageId: "opener" }],
      included: { messages: [message, { ...message, id: "reply", channelId: "thread", content: "Reply" }],
        profiles: [contractVersion === 2 ? { ...profile, statusEmoji: "😀", statusText: "Available" } : profile],
        members: [{ channelId: "thread", userId: "author", relation: "notify", source: "spoke", isCreator: true, role: null, memberId: null }], tags: [{ messageId: "opener", tag: "bug" }],
        participantCounts: [{ channelId: "thread", count: 1 }] }, page: { hasMore: true, nextCursor: "cursor" } })
    const result = normalizeThreadResources("forum", body)
    expect(result.channel).toEqual(channel)
    expect(result.threads).toEqual(body.threads.map((thread) => ({ ...thread, resourceComplete: true })))
    expect(result.included.messages).toEqual(body.included.messages.map((row) => ({ ...row, resourceComplete: contractVersion === 3 })))
    expect(result.included.profiles).toEqual([profile])
    expect(result.included.previews).toEqual([body.included.messages[1]])
    expect(result.included.members).toEqual(body.included.members)
    expect(result.page).toEqual(body.page)
    expect(() => normalizeThreadResources("forum", { ...body, contractVersion: 4 } as never)).toThrow("Unknown thread resource contract")
    expect(() => normalizeThreadResources("forum", { ...body, threads: [{ ...body.threads[0], messageCount: -1 }] } as never)).toThrow()
  })
})
