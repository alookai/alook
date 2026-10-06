import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { writeCommunityProfilePatches } from "@/lib/community/profile-seed"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { getCanonicalCommunityMessages, getCanonicalCommunityChannels } from "@/lib/community-db/sync"
import { forumFeedWindow, type ForumFeedTransportPage } from "./forum-feed-window"
import { CONVERSATION_READ_TIMEOUT_MS } from "@/lib/community/conversation-read"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
const useForumTagsMock = vi.fn(() => ({
  data: { tags: ["bug"] },
  isSuccess: true,
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("./use-channel-panels", () => ({
  useForumTags: (...args: unknown[]) => useForumTagsMock(...args),
}))

import {
  forumFeedPageQueryFn,
  mapForumFeedPages,
  removeForumPostFromFeed,
  useForumFeed,
} from "./use-forum-feed"

let client: QueryClient
beforeEach(async () => { client = (await createCommunityQueryOwner()).client; apiFetchMock.mockReset() })

async function projectPages(pages: ForumFeedTransportPage[], canonical?: ReadonlyMap<string, never>) {
  apiFetchMock.mockReset()
  for (const page of pages) apiFetchMock.mockResolvedValueOnce(page)
  const data = await client.fetchInfiniteQuery({ queryKey: communityKeys.forumFeed("forum_1", null), queryFn: forumFeedPageQueryFn("forum_1", null, client), initialPageParam: null as string | null, getNextPageParam: (last) => last.hasMore ? last.nextCursor : undefined, pages: pages.length })
  const registry = getCommunityDbRegistry(client)!
  return mapForumFeedPages(data.pages, canonical ?? new Map(getCanonicalCommunityMessages(client).map((row) => [row.id, row])), new Map(getCanonicalCommunityChannels(client).map((row) => [row.id, row])), new Map([...registry.collections.profiles.values()].map((row) => [row.userId, row])))
}

const emptyIncluded = {
  parentMessages: [],
  firstMessages: [],
  tags: [],
  participants: [],
}

describe("forumFeedPageQueryFn", () => {
  it.each(["deadline", "cancellation"])("retires a hanging feed on %s without late profiles or canonical writes", async (reason) => {
    let release!: (value: unknown) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const controller = new AbortController()
    vi.useFakeTimers()
    try {
      const result = forumFeedPageQueryFn("forum_1", null, client)({ pageParam: null, signal: controller.signal })
      const rejected = expect(result).rejects.toMatchObject({ name: reason === "deadline" ? "ConversationReadTimeoutError" : "AbortError" })
      await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
      if (reason === "deadline") await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
      else controller.abort(new DOMException("Retired", "AbortError"))
      await rejected
      expect(apiFetchMock.mock.calls[0]![1].signal.aborted).toBe(true)
      release({ serverId: "server_1", parentType: "forum", threads: [], included: { ...emptyIncluded, parentMessages: [{ id: "late-opener", channelId: "forum_1", seq: 1, content: "late", authorId: "late-author", authorName: "Late", authorImage: null, authorAvatarVersion: 1 }] }, hasMore: false })
      await Promise.resolve()
      await Promise.resolve()
      expect(getCanonicalCommunityMessages(client)).toEqual([])
      expect(getCommunityDbRegistry(client)!.collections.profiles.get("late-author")).toBeUndefined()
      apiFetchMock.mockResolvedValueOnce({ serverId: "server_1", parentType: "forum", threads: [], included: emptyIncluded, hasMore: false })
      await expect(forumFeedPageQueryFn("forum_1", null, client)({ pageParam: null })).resolves.toMatchObject({ threads: [], hasMore: false })
    } finally { vi.useRealTimers() }
  })

  it("includes feed collection preloads in the deadline", async () => {
    let release!: () => void
    vi.spyOn(getCommunityDbRegistry(client)!.collections.messages, "preload").mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    vi.useFakeTimers()
    try {
      const result = forumFeedPageQueryFn("forum_1", null, client)({ pageParam: null })
      const rejected = expect(result).rejects.toMatchObject({ name: "ConversationReadTimeoutError" })
      await vi.advanceTimersByTimeAsync(CONVERSATION_READ_TIMEOUT_MS)
      await rejected
      release()
      await Promise.resolve()
      expect(apiFetchMock).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  beforeEach(() => {
    apiFetchMock.mockReset()


  })

  it("requests the canonical created-order collection with includes, tag, and cursor", async () => {
    apiFetchMock.mockResolvedValue({ serverId: "server_1", parentType: "forum", threads: [], included: emptyIncluded, hasMore: false })
    await forumFeedPageQueryFn("forum_one", "bug", client)({ pageParam: "opaque cursor" })

    const url = apiFetchMock.mock.calls[0]![0] as string
    expect(url).toContain("/api/community/channels/forum_one/threads?")
    const params = new URL(url, "http://localhost").searchParams
    expect(params.get("order")).toBe("createdAt")
    expect(params.get("include")).toBe("parentMessage,firstMessage,tags,participants")
    expect(params.get("tag")).toBe("bug")
    expect(params.get("cursor")).toBe("opaque cursor")
  })

  it("uses the archive tag as its own feed query", async () => {
    apiFetchMock.mockResolvedValue({ serverId: "server_1", parentType: "forum", threads: [{ id: "archived-post", name: "Post", creatorId: "author", messageCount: 1, parentMessageId: "opener", lastMessageAt: null, createdAt: "2026-10-04T00:00:00Z", activityAt: "2026-10-04T00:00:00Z" }], included: { ...emptyIncluded, tags: [{ messageId: "opener", tag: "archived" }] }, hasMore: false })
    await forumFeedPageQueryFn("forum_one", "archived", client)({ pageParam: null })

    const url = apiFetchMock.mock.calls[0]![0] as string
    expect(new URL(url, "http://localhost").searchParams.get("tag")).toBe("archived")
    expect(getCanonicalCommunityChannels(client).find((row) => row.id === "archived-post")).toMatchObject({ archived: false, tags: ["archived"] })
  })

  it("passes the query abort signal through to the request", async () => {
    apiFetchMock.mockResolvedValue({ serverId: "server_1", parentType: "forum", threads: [], included: emptyIncluded, hasMore: false })
    const controller = new AbortController()

    await forumFeedPageQueryFn("forum_one", null, client)({
      pageParam: null,
      signal: controller.signal,
    })

    expect(apiFetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/community/channels/forum_one/threads?"),
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
  })

  it("seeds opener and participant profiles while returning only the ID window", async () => {
    const page = {
      serverId: "server_1", parentType: "forum",
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

    const result = await forumFeedPageQueryFn("forum_one", null, client)({ pageParam: null })

    expect(result).toEqual(forumFeedWindow(page))
    const profiles = getCommunityDbRegistry(client)!.collections.profiles
    expect(profiles.get("author_1")).toMatchObject({ name: "Alice", avatarVersion: 2 })
    expect(profiles.get("participant_1")).toMatchObject({ name: "Bob", avatar: "bob.png", avatarVersion: 3 })
    expect(profiles.get("participant_2")).toMatchObject({ avatarVersion: 0 })
  })
})

describe("mapForumFeedPages", () => {
  it("keeps one operation baseline across pages and excludes duplicate profile publications", async () => {
    const registry = getCommunityDbRegistry(client)!
    const page = (id: string, name: string, more: boolean): ForumFeedTransportPage => ({
      serverId: "server_1", parentType: "forum", hasMore: more, ...(more ? { nextCursor: "next" } : {}),
      threads: [{ id, name: id, creatorId: "author", messageCount: 1, parentMessageId: `opener_${id}`, createdAt: "2026-08-08T00:00:00.000Z", lastMessageAt: null, activityAt: "2026-08-08T00:00:00.000Z" }],
      included: { parentMessages: [{ id: `opener_${id}`, channelId: "forum_1", seq: 1, content: id, authorId: "author", authorName: name, authorImage: null, authorAvatarVersion: 0 }], firstMessages: [], tags: [], participants: [{ channelId: id, userId: "author", userName: name, userImage: null, userAvatarVersion: 0 }] },
    })
    let release!: (value: ForumFeedTransportPage) => void
    apiFetchMock.mockResolvedValueOnce(page("first", "Initial", true)).mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const request = client.fetchInfiniteQuery({ queryKey: communityKeys.forumFeed("forum_1", null), queryFn: forumFeedPageQueryFn("forum_1", null, client), initialPageParam: null as string | null, getNextPageParam: (last) => last.hasMore ? last.nextCursor : undefined, pages: 2 })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    writeCommunityProfilePatches([{ id: "author", identityAbout: { name: "Newer WS" } }], registry, { event: true })
    const next = page("second", "Old later page", false), duplicate = page("first", "Old duplicate", false)
    release({ ...next, threads: [...next.threads, ...duplicate.threads], included: { ...next.included, parentMessages: [...next.included.parentMessages, ...duplicate.included.parentMessages], participants: [...next.included.participants, ...duplicate.included.participants] } })
    const result = await request
    expect(registry.collections.profiles.get("author")?.name).toBe("Newer WS")
    expect(result.pages).toHaveLength(2)
    expect(result.pageParams).toEqual([null, "next"])
    expect(registry.collections.channels.get("first")?.messageCount).toBe(1)
  })
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
            { id: "m_delete", channelId: "forum", seq: 1, content: "delete", authorId: "u", authorName: "U", authorImage: null, authorAvatarVersion: 0 },
            { id: "m_keep", channelId: "forum", seq: 2, content: "keep", authorId: "u", authorName: "U", authorImage: null, authorAvatarVersion: 0 },
          ],
          firstMessages: [{ channelId: "delete", content: "delete" }, { channelId: "keep", content: "keep" }],
          tags: [{ messageId: "m_delete", tag: "delete" }, { messageId: "m_keep", tag: "keep" }],
          participants: [
            { channelId: "delete", userId: "u", userName: "U", userImage: null, userAvatarVersion: 0 },
            { channelId: "keep", userId: "u", userName: "U", userImage: null, userAvatarVersion: 0 },
          ],
        },
        hasMore: false,
      }],
      pageParams: [null],
    }

    const windows = { ...data, pages: data.pages.map((page) => forumFeedWindow(page)) }
    const projected = removeForumPostFromFeed(windows, "delete", "m_delete")!

    expect(projected.pages[0].threads.map((row) => row.id)).toEqual(["keep"])
    expect(projected.pages[0].threads).toEqual([{ id: "keep", openerMessageId: "m_keep", participantIds: ["u"] }])
    expect(projected.pages[0]).not.toHaveProperty("included")
    expect(projected.pageParams).toEqual([null])
  })

  it("joins included resources, deduplicates pages, and keeps newest-created first", async () => {
    const pages: ForumFeedTransportPage[] = [
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
            { id: "m1", channelId: "forum_1", seq: 41, content: "", authorId: "creator_1", authorName: "Creator", authorImage: null, authorAvatarVersion: 0 },
            { id: "m2", channelId: "forum_1", seq: 42, content: "  Opener title  ", authorId: "u2", authorName: "Alice", authorImage: null, authorAvatarVersion: 0, createdAt: "2026-08-08T00:15:00.000Z" },
          ],
          firstMessages: [{ channelId: "t2", content: "First reply preview" }],
          tags: [{ messageId: "m2", tag: "bug" }, { messageId: "m2", tag: "help" }],
          participants: [
            { channelId: "t2", userId: "u2", userName: "Alice", userImage: null, userAvatarVersion: 0, participantCount: 7 },
            { channelId: "t2", userId: "u3", userName: "Bob", userImage: "bob.png", userAvatarVersion: 0, participantCount: 7 },
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
        included: { ...emptyIncluded,
          parentMessages: [{ id: "m2", channelId: "forum_1", seq: 42, content: "duplicate title", authorId: "u2", authorName: "Duplicate Alice", authorImage: null, authorAvatarVersion: 0 }],
          participants: [{ channelId: "t2", userId: "u3", userName: "Duplicate Bob", userImage: "duplicate.png", userAvatarVersion: 0 }],
        },
        hasMore: false,
      },
    ]

    const result = await projectPages(pages)
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

  it("projects a canonical opener without reviving transport message fields", async () => {
    const pages: ForumFeedTransportPage[] = [{
      serverId: "server_1",
      parentType: "forum",
      threads: [{
        id: "post-1",
        name: "transport title",
        creatorId: "transport-author",
        messageCount: 1,
        parentMessageId: "opener-1",
        lastMessageAt: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        activityAt: "2026-08-08T00:00:00.000Z",
      }],
      included: {
        parentMessages: [{
          id: "opener-1",
          channelId: "forum-1",
          seq: 7,
          content: "transport content",
          authorId: "transport-author",
          authorName: "Transport",
          authorImage: "/transport.png",
          authorAvatarVersion: 4,
          createdAt: "2026-08-08T00:00:00.000Z",
        }],
        firstMessages: [{ channelId: "post-1", content: "transport preview" }],
        tags: [],
        participants: [],
      },
      hasMore: false,
    }]
    const canonical = new Map([[
      "opener-1",
      {
        id: "opener-1",
        type: "chat",
        content: "canonical content",
        authorId: undefined,
        authorName: "Canonical",
        authorAvatar: undefined,
        authorAvatarVersion: undefined,
        createdAt: undefined,
        seq: undefined,
      } as never,
    ]])

    const result = await projectPages(pages, canonical)
    expect(result).toEqual([
      expect.objectContaining({
        name: "canonical content",
        authorId: "transport-author",
        authorAvatarVersion: 0,
        preview: "transport preview",
        parent: { authorName: "Canonical", text: "transport preview" },
      }),
    ])
    expect(result[0]).not.toHaveProperty("openerCreatedAt")
    expect(result[0]).not.toHaveProperty("parentSeq")
  })

  it("matches SQLite BINARY id ordering for equal-created mixed-case nanoids", async () => {
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
      parentMessageId: "opener:" + id,
      lastMessageAt: null,
      createdAt: "2026-08-17T06:35:00.000Z",
      activityAt: "2026-08-17T06:35:00.000Z",
    }))
    const pages: ForumFeedTransportPage[] = [
      {
        serverId: "server_1",
        parentType: "forum",
        threads: threads.slice(2),
        included: { ...emptyIncluded, parentMessages: threads.slice(2).map((thread) => ({ id: thread.parentMessageId, channelId: "forum_1", seq: 1, content: "", authorId: "creator", authorName: "Creator", authorImage: null, authorAvatarVersion: 0 })) },
        hasMore: true, nextCursor: "next",
      },
      {
        serverId: "server_1",
        parentType: "forum",
        threads: threads.slice(0, 2),
        included: { ...emptyIncluded, parentMessages: threads.slice(0, 2).map((thread) => ({ id: thread.parentMessageId, channelId: "forum_1", seq: 1, content: "", authorId: "creator", authorName: "Creator", authorImage: null, authorAvatarVersion: 0 })) },
        hasMore: false,
      },
    ]

    expect((await projectPages(pages)).map((thread) => thread.id)).toEqual(expectedIds)
  })
})

describe("useForumFeed", () => {
  it("projects the cached page through the owning query client", async () => {
    const queryClient = client
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
    queryClient.setQueryData(communityKeys.forumFeed("forum_one", null), {
      pages: [{
        serverId: "server_one",
        parentType: "forum",
        threads: [],
        included: emptyIncluded,
        hasMore: false,
      }],
      pageParams: [null],
    })
    function QueryWrapper({ children }: PropsWithChildren) {
      return createElement(QueryClientProvider, { client: queryClient }, children)
    }
    const rendered = renderHook(() => useForumFeed("server_one", "forum_one"), {
      wrapper: QueryWrapper,
    })

    expect(useForumTagsMock).toHaveBeenCalledWith("forum_one", true)
    expect(rendered.result.current.tag).toBe("All")
    expect(rendered.result.current.posts).toEqual([])
  })
})
