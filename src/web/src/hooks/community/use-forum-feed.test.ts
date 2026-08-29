import { beforeEach, describe, expect, it, vi } from "vitest"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  forumFeedPageQueryFn,
  mapForumFeedPages,
  removeForumPostFromFeed,
  type ForumFeedPage,
} from "./use-forum-feed"

const emptyIncluded = {
  parentMessages: [],
  firstMessages: [],
  tags: [],
  participants: [],
}

describe("forumFeedPageQueryFn", () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    useCommunityWsStore.getState().reset()
    useCommunityWsStore.getState().activateProfileAccount("viewer")
  })

  it("requests the canonical created-order collection with includes, tag, and cursor", async () => {
    apiFetchMock.mockResolvedValue({ threads: [], included: emptyIncluded, hasMore: false })
    await forumFeedPageQueryFn("forum_one", "bug")({ pageParam: "opaque cursor" })

    const url = apiFetchMock.mock.calls[0]![0] as string
    expect(url).toContain("/api/community/channels/forum_one/threads?")
    const params = new URL(url, "http://localhost").searchParams
    expect(params.get("order")).toBe("createdAt")
    expect(params.get("include")).toBe("parentMessage,firstMessage,tags,participants")
    expect(params.get("tag")).toBe("bug")
    expect(params.get("cursor")).toBe("opaque cursor")
  })

  it("uses the archive tag as its own feed query", async () => {
    apiFetchMock.mockResolvedValue({ threads: [], included: emptyIncluded, hasMore: false })
    await forumFeedPageQueryFn("forum_one", "archived")({ pageParam: null })

    const url = apiFetchMock.mock.calls[0]![0] as string
    expect(new URL(url, "http://localhost").searchParams.get("tag")).toBe("archived")
  })

  it("seeds opener and participant profiles while returning the raw page", async () => {
    const page = {
      threads: [],
      included: {
        parentMessages: [{
          id: "m1",
          channelId: "forum_one",
          seq: 1,
          content: "post",
          authorId: "author_1",
          authorName: "Alice",
          authorImage: null,
          authorAvatarVersion: 2,
        }],
        firstMessages: [],
        tags: [],
        participants: [
          { channelId: "thread_1", userId: "participant_1", userName: "Bob", userImage: "bob.png", userAvatarVersion: 3 },
          { channelId: "thread_1", userId: "participant_2", userName: null, userImage: null, userAvatarVersion: 0 },
        ],
      },
      hasMore: false,
    }
    apiFetchMock.mockResolvedValue(page)

    const result = await forumFeedPageQueryFn("forum_one", null)({ pageParam: null })

    expect(result).toBe(page)
    expect(useCommunityWsStore.getState().profilesByUserId.get("author_1")).toMatchObject({
      name: "Alice",
      avatar: "A",
      avatarVersion: 2,
    })
    expect(useCommunityWsStore.getState().profilesByUserId.get("participant_1")).toMatchObject({
      name: "Bob",
      avatar: "bob.png",
      avatarVersion: 3,
    })
    const anonymousParticipant = useCommunityWsStore.getState().profilesByUserId.get("participant_2")
    expect(anonymousParticipant).toMatchObject({ avatarVersion: 0 })
    expect(anonymousParticipant).not.toHaveProperty("name")
  })
})

describe("mapForumFeedPages", () => {
  it("removes a post and every included row owned by its opener/child unit", () => {
    const thread = (id: string, parentMessageId: string) => ({
      id,
      name: id,
      creatorId: "creator",
      messageCount: 1,
      parentMessageId,
      lastMessageAt: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      activityAt: "2026-08-23T00:00:00.000Z",
    })
    const data = {
      pages: [{
        serverId: "server_1",
        parentType: "forum",
        threads: [thread("delete", "m_delete"), thread("keep", "m_keep")],
        included: {
          parentMessages: [
            { id: "m_delete", channelId: "forum", seq: 1, content: "delete", authorId: "u", authorName: "U", authorImage: null },
            { id: "m_keep", channelId: "forum", seq: 2, content: "keep", authorId: "u", authorName: "U", authorImage: null },
          ],
          firstMessages: [{ channelId: "delete", content: "delete" }, { channelId: "keep", content: "keep" }],
          tags: [{ messageId: "m_delete", tag: "delete" }, { messageId: "m_keep", tag: "keep" }],
          participants: [
            { channelId: "delete", userId: "u", userName: "U", userImage: null },
            { channelId: "keep", userId: "u", userName: "U", userImage: null },
          ],
        },
        hasMore: false,
      }],
      pageParams: [null],
    }

    const projected = removeForumPostFromFeed(data, "delete", "m_delete")!

    expect(projected.pages[0].threads.map((row) => row.id)).toEqual(["keep"])
    expect(projected.pages[0].included).toEqual({
      parentMessages: [expect.objectContaining({ id: "m_keep" })],
      firstMessages: [{ channelId: "keep", content: "keep" }],
      tags: [{ messageId: "m_keep", tag: "keep" }],
      participants: [expect.objectContaining({ channelId: "keep" })],
    })
  })

  it("joins included resources, deduplicates pages, and keeps newest-created first", () => {
    const pages: ForumFeedPage[] = [
      {
        serverId: "server_1",
        parentType: "forum",
        threads: [
          {
            id: "t2",
            name: "fallback two",
            creatorId: "creator_2",
            messageCount: 2,
            parentMessageId: "m2",
            lastMessageAt: "2026-08-08T02:00:00.000Z",
            createdAt: "2026-08-08T00:00:00.000Z",
            activityAt: "2026-08-08T02:00:00.000Z",
          },
          {
            id: "t1",
            name: "fallback one",
            creatorId: "creator_1",
            messageCount: 1,
            parentMessageId: "m1",
            lastMessageAt: null,
            createdAt: "2026-08-08T01:00:00.000Z",
            activityAt: "2026-08-08T01:00:00.000Z",
          },
        ],
        included: {
          parentMessages: [
            { id: "m2", channelId: "forum_1", seq: 42, content: "  Opener title  ", authorId: "u2", authorName: "Alice", authorImage: null, createdAt: "2026-08-08T00:15:00.000Z" },
          ],
          firstMessages: [{ channelId: "t2", content: "First reply preview" }],
          tags: [{ messageId: "m2", tag: "bug" }, { messageId: "m2", tag: "help" }],
          participants: [
            { channelId: "t2", userId: "u2", userName: "Alice", userImage: null, participantCount: 7 },
            { channelId: "t2", userId: "u3", userName: "Bob", userImage: "bob.png", participantCount: 7 },
          ],
        },
        hasMore: true,
        nextCursor: "next",
      },
      {
        serverId: "server_1",
        parentType: "forum",
        threads: [
          {
            id: "t2",
            name: "duplicate",
            creatorId: "duplicate",
            messageCount: 99,
            parentMessageId: "m2",
            lastMessageAt: null,
            createdAt: "2026-08-07T00:00:00.000Z",
            activityAt: "2026-08-07T00:00:00.000Z",
          },
        ],
        included: emptyIncluded,
        hasMore: false,
      },
    ]

    const result = mapForumFeedPages(pages)
    expect(result.map((thread) => thread.id)).toEqual(["t1", "t2"])
    expect(result[1]).toMatchObject({
      name: "  Opener title  ",
      parentSeq: 42,
      openerCreatedAt: "2026-08-08T00:15:00.000Z",
      authorId: "u2",
      authorAvatar: "A",
      preview: "First reply preview",
      parent: { authorName: "Alice", text: "First reply preview" },
      tags: ["bug", "help"],
      participantCount: 7,
      participants: [
        { id: "u2", name: "Alice", avatar: "A" },
        { id: "u3", name: "Bob", avatar: "bob.png" },
      ],
    })
    expect(result[0]).toMatchObject({
      name: "fallback one",
      authorId: "creator_1",
      preview: "",
      tags: [],
      participantCount: 0,
    })
  })

  it("matches SQLite BINARY id ordering for equal-created mixed-case nanoids", () => {
    const expectedIds = [
      "kMRip4KDm4Ki2HU8vQ2qd",
      "bc02tEwQaazjdPwrMuNih",
      "XzKeKetmiRMJ16hwOrhSl",
      "3kY1MAppCm6RYM4IvnXPN",
    ]
    const threads = expectedIds.map((id) => ({
      id,
      name: id,
      creatorId: "creator",
      messageCount: 0,
      parentMessageId: null,
      lastMessageAt: null,
      createdAt: "2026-08-17T06:35:00.000Z",
      activityAt: "2026-08-17T06:35:00.000Z",
    }))
    const pages: ForumFeedPage[] = [
      {
        serverId: "server_1",
        parentType: "forum",
        threads: threads.slice(2),
        included: emptyIncluded,
        hasMore: false,
      },
      {
        serverId: "server_1",
        parentType: "forum",
        threads: threads.slice(0, 2),
        included: emptyIncluded,
        hasMore: false,
      },
    ]

    expect(mapForumFeedPages(pages).map((thread) => thread.id)).toEqual(expectedIds)
  })
})
