import { beforeEach, describe, expect, it, vi } from "vitest"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  forumActivityPageQueryFn,
  mapForumActivityPages,
  type ForumActivityPage,
} from "./use-forum-feed"

const emptyIncluded = {
  parentMessages: [],
  firstMessages: [],
  tags: [],
  participants: [],
}

describe("forumActivityPageQueryFn", () => {
  beforeEach(() => apiFetchMock.mockReset())

  it("requests the canonical activity collection with includes, tag, and cursor", async () => {
    apiFetchMock.mockResolvedValue({ threads: [], included: emptyIncluded, hasMore: false })
    await forumActivityPageQueryFn("forum_one", "bug")({ pageParam: "opaque cursor" })

    const url = apiFetchMock.mock.calls[0]![0] as string
    expect(url).toContain("/api/community/channels/forum_one/threads?")
    const params = new URL(url, "http://localhost").searchParams
    expect(params.get("order")).toBe("activity")
    expect(params.get("include")).toBe("parentMessage,firstMessage,tags,participants")
    expect(params.get("tag")).toBe("bug")
    expect(params.get("cursor")).toBe("opaque cursor")
  })
})

describe("mapForumActivityPages", () => {
  it("joins included resources, deduplicates pages, and keeps latest activity first", () => {
    const pages: ForumActivityPage[] = [
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
            { id: "m2", channelId: "forum_1", seq: 42, content: "  Opener title  ", authorId: "u2", authorName: "Alice", authorImage: null },
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

    const result = mapForumActivityPages(pages)
    expect(result.map((thread) => thread.id)).toEqual(["t2", "t1"])
    expect(result[0]).toMatchObject({
      name: "  Opener title  ",
      parentSeq: 42,
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
    expect(result[1]).toMatchObject({
      name: "fallback one",
      authorId: "creator_1",
      preview: "",
      tags: [],
      participantCount: 0,
    })
  })
})
