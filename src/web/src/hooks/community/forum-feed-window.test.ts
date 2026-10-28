import { describe, expect, it } from "vitest"
import { BUSINESS_SCHEMA_VERSION, communityReadSchemas } from "@alook/shared"
import { normalizeThreadResources } from "./forum-feed-window"

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
})
