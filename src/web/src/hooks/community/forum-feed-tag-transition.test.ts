import { describe, expect, it, vi } from "vitest"
import { QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { mapForumFeedPages, type ForumFeedPage } from "./use-forum-feed"
import {
  beginForumFeedTagTransition,
  commitForumFeedTagTransition,
  forumFeedMatchesTags,
  hasForumFeedTagTransition,
  projectForumFeedWsTags,
  projectForumThreadsThroughActiveTagTransitions,
  rollbackForumFeedTagTransition,
} from "./forum-feed-tag-transition"

type FeedData = InfiniteData<ForumFeedPage, string | null>

function thread(id: string, openerMessageId = `opener_${id}`) {
  return {
    id,
    name: id,
    creatorId: `author_${id}`,
    messageCount: 1,
    parentMessageId: openerMessageId,
    lastMessageAt: "2026-09-05T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
    activityAt: "2026-09-05T00:00:00.000Z",
  }
}

function feed(
  rows: Array<{ id: string; opener?: string; tags?: string[] }>,
  pageParam: string | null = null,
): FeedData {
  return {
    pages: [{
      serverId: "server_1",
      parentType: "forum",
      threads: rows.map((row) => thread(row.id, row.opener)),
      included: {
        parentMessages: rows.map((row, index) => ({
          id: row.opener ?? `opener_${row.id}`,
          channelId: "forum_1",
          seq: index + 1,
          content: row.id,
          authorId: `author_${row.id}`,
          authorName: row.id,
          authorImage: null,
          authorAvatarVersion: 0,
        })),
        firstMessages: rows.map((row) => ({ channelId: row.id, content: `body ${row.id}` })),
        tags: rows.flatMap((row) => (row.tags ?? []).map((tag) => ({
          messageId: row.opener ?? `opener_${row.id}`,
          tag,
        }))),
        participants: rows.map((row) => ({
          channelId: row.id,
          userId: `author_${row.id}`,
          userName: row.id,
          userImage: null,
          userAvatarVersion: 0,
        })),
      },
      hasMore: false,
    }],
    pageParams: [pageParam],
  }
}

function ids(queryClient: QueryClient, filter: string | null) {
  return queryClient.getQueryData<FeedData>(communityKeys.forumFeed("forum_1", filter))
    ?.pages.flatMap((page) => page.threads.map((row) => row.id)) ?? []
}

function start(
  queryClient: QueryClient,
  previousTags: string[],
  tags: string[],
  openerMessageId = "opener_target",
) {
  return beginForumFeedTagTransition(queryClient, {
    forumChannelId: "forum_1",
    threadId: "target",
    openerMessageId,
    previousTags,
    tags,
  })!
}

describe("forum feed tag transition owner", () => {
  it("matches the authoritative All, ordinary, and Archived partitions", () => {
    expect(forumFeedMatchesTags(null, ["bug"])).toBe(true)
    expect(forumFeedMatchesTags("bug", ["bug"])).toBe(true)
    expect(forumFeedMatchesTags("help", ["bug"])).toBe(false)
    expect(forumFeedMatchesTags(null, ["bug", "archived"])).toBe(false)
    expect(forumFeedMatchesTags("bug", ["bug", "archived"])).toBe(false)
    expect(forumFeedMatchesTags("archived", ["bug", "archived"])).toBe(true)
  })

  it("removes Archive and Unarchive source rows without inserting a destination rank", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([
      { id: "target", tags: ["bug"] },
    ]))
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", "bug"), feed([
      { id: "target", tags: ["bug"] },
    ]))
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", "archived"), feed([]))

    const archive = start(queryClient, ["bug"], ["bug", "archived"])
    expect(ids(queryClient, null)).toEqual([])
    expect(ids(queryClient, "bug")).toEqual([])
    expect(ids(queryClient, "archived")).toEqual([])
    commitForumFeedTagTransition(queryClient, archive, ["bug", "archived"])
    expect(ids(queryClient, "archived")).toEqual([])

    queryClient.setQueryData(communityKeys.forumFeed("forum_1", "archived"), feed([
      { id: "target", tags: ["bug", "archived"] },
    ]))
    const unarchive = start(queryClient, ["bug", "archived"], ["bug"])
    expect(ids(queryClient, "archived")).toEqual([])
    commitForumFeedTagTransition(queryClient, unarchive, ["bug"])
    expect(ids(queryClient, null)).toEqual([])
    expect(ids(queryClient, "bug")).toEqual([])
  })

  it("merges only the removed exact slice and preserves concurrent siblings", () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    queryClient.setQueryData(key, feed([
      { id: "target", tags: ["bug"] },
      { id: "sibling", tags: ["keep"] },
    ]))
    const token = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(key, feed([
      { id: "sibling", tags: ["keep"] },
      { id: "concurrent", tags: ["new"] },
    ]))

    expect(rollbackForumFeedTagTransition(queryClient, token)).toBe(true)
    expect(ids(queryClient, null)).toEqual(["target", "sibling", "concurrent"])
    const restored = queryClient.getQueryData<FeedData>(key)!.pages[0].included
    expect(restored.parentMessages.map((row) => row.id)).toEqual([
      "opener_target",
      "opener_sibling",
      "opener_concurrent",
    ])
    expect(restored.tags).toContainEqual({ messageId: "opener_target", tag: "bug" })
  })

  it("prevents an older generation from rolling back a newer exact intent", () => {
    const queryClient = new QueryClient()
    const archivedKey = communityKeys.forumFeed("forum_1", "archived")
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([
      { id: "target", tags: ["bug"] },
    ]))
    const older = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(archivedKey, feed([
      { id: "target", tags: ["bug", "archived"] },
    ]))
    const newer = start(queryClient, ["bug", "archived"], ["bug"])

    expect(rollbackForumFeedTagTransition(queryClient, older)).toBe(false)
    expect(hasForumFeedTagTransition(queryClient, newer)).toBe(true)
    expect(ids(queryClient, "archived")).toEqual([])
    expect(rollbackForumFeedTagTransition(queryClient, newer)).toBe(true)
    expect(ids(queryClient, "archived")).toEqual(["target"])
  })

  it("carries the exact rollback slice into a repeated programmatic intent", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([
      { id: "target", tags: ["bug"] },
    ]))
    const older = start(queryClient, ["bug"], ["bug", "archived"])
    const newer = start(queryClient, ["bug"], ["bug", "archived"])

    expect(rollbackForumFeedTagTransition(queryClient, older)).toBe(false)
    expect(rollbackForumFeedTagTransition(queryClient, newer)).toBe(true)
    expect(ids(queryClient, null)).toEqual(["target"])
  })

  it("restores an authoritative non-archive response into its moved cursor page", () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    const other = feed([{ id: "other", tags: ["keep"] }], "other_cursor")
    const target = feed([{ id: "target", tags: ["bug"] }], "target_cursor")
    queryClient.setQueryData<FeedData>(key, {
      pages: [other.pages[0]!, target.pages[0]!],
      pageParams: ["other_cursor", "target_cursor"],
    })

    const token = start(queryClient, ["bug"], ["bug", "archived"])
    const movedTargetPage = feed([], "target_cursor")
    queryClient.setQueryData<FeedData>(key, {
      pages: [movedTargetPage.pages[0]!, other.pages[0]!],
      pageParams: ["target_cursor", "other_cursor"],
    })

    commitForumFeedTagTransition(queryClient, token, [" BUG ", "bug"])

    const restored = queryClient.getQueryData<FeedData>(key)!
    expect(restored.pages[0]!.threads.map((row) => row.id)).toEqual(["target"])
    expect(restored.pages[0]!.included.tags).toEqual([
      { messageId: "opener_target", tag: "bug" },
    ])
    expect(ids(queryClient, null)).toEqual(["target", "other"])
    expect(hasForumFeedTagTransition(queryClient, token)).toBe(false)
  })

  it("ignores non-partition cache keys and skips restore after cursor replacement", () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    queryClient.setQueryData(communityKeys.forumFeeds("forum_1"), feed([
      { id: "unscoped", tags: ["bug"] },
    ]))
    queryClient.setQueryData(key, feed([
      { id: "target", tags: ["bug"] },
    ], "target_cursor"))

    const token = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(key, feed([], "replacement_cursor"))

    expect(rollbackForumFeedTagTransition(queryClient, token)).toBe(true)
    expect(ids(queryClient, null)).toEqual([])
  })

  it("ignores an older success while a newer exact generation is active", () => {
    const queryClient = new QueryClient()
    const archivedKey = communityKeys.forumFeed("forum_1", "archived")
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([
      { id: "target", tags: ["bug"] },
    ]))
    const older = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(archivedKey, feed([
      { id: "target", tags: ["bug", "archived"] },
    ]))
    const newer = start(queryClient, ["bug", "archived"], ["bug"])

    commitForumFeedTagTransition(queryClient, older, ["bug", "archived"])

    expect(hasForumFeedTagTransition(queryClient, newer)).toBe(true)
    expect(ids(queryClient, "archived")).toEqual([])
  })

  it("settles different posts independently", () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    queryClient.setQueryData(key, feed([
      { id: "target", tags: ["bug"] },
      { id: "other", tags: ["help"] },
    ]))
    const target = start(queryClient, ["bug"], ["bug", "archived"])
    const other = beginForumFeedTagTransition(queryClient, {
      forumChannelId: "forum_1",
      threadId: "other",
      openerMessageId: "opener_other",
      previousTags: ["help"],
      tags: ["help", "archived"],
    })!

    expect(ids(queryClient, null)).toEqual([])
    rollbackForumFeedTagTransition(queryClient, target)
    expect(ids(queryClient, null)).toEqual(["target"])
    expect(hasForumFeedTagTransition(queryClient, other)).toBe(true)
    commitForumFeedTagTransition(queryClient, other, ["help", "archived"])
    expect(ids(queryClient, null)).toEqual(["target"])
  })

  it("requires the local cached opener and never hides a reused child identity", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([
      { id: "target", opener: "opener_new", tags: ["bug"] },
    ]))
    const token = start(queryClient, ["bug"], ["bug", "archived"], "opener_old")

    expect(ids(queryClient, null)).toEqual(["target"])
    const projected = projectForumThreadsThroughActiveTagTransitions(
      queryClient,
      "forum_1",
      null,
      mapForumFeedPages(queryClient.getQueryData<FeedData>(
        communityKeys.forumFeed("forum_1", null),
      )!.pages),
    )
    expect(projected.map((post) => post.id)).toEqual(["target"])
    expect(rollbackForumFeedTagTransition(queryClient, token)).toBe(true)
  })

  it("projects WS membership only with one consistent cached opener", () => {
    const queryClient = new QueryClient()
    const allKey = communityKeys.forumFeed("forum_1", null)
    queryClient.setQueryData(allKey, feed([{ id: "target", tags: ["bug"] }]))
    expect(projectForumFeedWsTags(queryClient, {
      forumChannelId: "forum_1",
      threadId: "target",
      tags: ["bug", "archived"],
    })).toBe(true)
    expect(ids(queryClient, null)).toEqual([])

    queryClient.setQueryData(allKey, feed([
      { id: "target", opener: "opener_one", tags: ["bug"] },
    ]))
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", "bug"), feed([
      { id: "target", opener: "opener_two", tags: ["bug"] },
    ]))
    expect(projectForumFeedWsTags(queryClient, {
      forumChannelId: "forum_1",
      threadId: "target",
      tags: ["bug", "archived"],
    })).toBe(false)
    expect(ids(queryClient, null)).toEqual(["target"])
    expect(ids(queryClient, "bug")).toEqual(["target"])
  })

  it("falls back to refetch when a cached child has no valid opener evidence", () => {
    const queryClient = new QueryClient()
    const invalid = feed([{ id: "target", tags: ["bug"] }])
    invalid.pages[0]!.threads[0]!.parentMessageId = null
    invalid.pages[0]!.included.parentMessages = []
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), invalid)

    expect(projectForumFeedWsTags(queryClient, {
      forumChannelId: "forum_1",
      threadId: "target",
      tags: ["bug", "archived"],
    })).toBe(false)
    expect(ids(queryClient, null)).toEqual(["target"])
  })

  it("keeps a newer local intent visually dominant over an intervening WS frame", () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    const stale = feed([{ id: "target", tags: ["bug"] }])
    queryClient.setQueryData(key, stale)
    const token = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(key, stale)

    expect(projectForumFeedWsTags(queryClient, {
      forumChannelId: "forum_1",
      threadId: "target",
      tags: ["bug"],
    })).toBe(true)
    const projected = projectForumThreadsThroughActiveTagTransitions(
      queryClient,
      "forum_1",
      null,
      mapForumFeedPages(stale.pages),
    )
    expect(projected).toEqual([])
    expect(hasForumFeedTagTransition(queryClient, token)).toBe(true)
  })

  it("removes a WS Unarchive from Archived without inserting into All", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", "archived"), feed([
      { id: "target", tags: ["archived"] },
    ]))
    queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), feed([]))

    expect(projectForumFeedWsTags(queryClient, {
      forumChannelId: "forum_1",
      threadId: "target",
      tags: [],
    })).toBe(true)
    expect(ids(queryClient, "archived")).toEqual([])
    expect(ids(queryClient, null)).toEqual([])
  })

  it("keeps every success notification frame removed across generation clear", async () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    const initial = feed([{ id: "target", tags: ["bug"] }])
    queryClient.setQueryData(key, initial)
    let token: ReturnType<typeof start> | null = null
    const frames: Array<{ active: boolean; ids: string[] }> = []
    const observer = new QueryObserver<FeedData>(queryClient, {
      queryKey: key,
      enabled: false,
      select: (data) => ({
        ...data,
        pages: [{
          ...data.pages[0]!,
          threads: projectForumThreadsThroughActiveTagTransitions(
            queryClient,
            "forum_1",
            null,
            mapForumFeedPages(data.pages),
          ).map((post) => thread(post.id, post.openerMessageId)),
        }],
      }),
    })
    const unsubscribe = observer.subscribe((result) => {
      frames.push({
        active: token ? hasForumFeedTagTransition(queryClient, token) : false,
        ids: result.data?.pages.flatMap((page) => page.threads.map((row) => row.id)) ?? [],
      })
    })
    token = start(queryClient, ["bug"], ["bug", "archived"])
    queryClient.setQueryData(key, initial)
    commitForumFeedTagTransition(queryClient, token, ["bug", "archived"])
    await vi.waitFor(() => expect(hasForumFeedTagTransition(queryClient, token!)).toBe(false))
    unsubscribe()

    const afterRemoval = frames.slice(frames.findIndex((frame) => frame.ids.length === 0))
    expect(afterRemoval.length).toBeGreaterThan(0)
    expect(afterRemoval.every((frame) => !frame.ids.includes("target"))).toBe(true)
    expect(ids(queryClient, null)).toEqual([])
  })

  it("publishes rollback membership and generation clear in the same terminal frame", async () => {
    const queryClient = new QueryClient()
    const key = communityKeys.forumFeed("forum_1", null)
    queryClient.setQueryData(key, feed([{ id: "target", tags: ["bug"] }]))
    let token: ReturnType<typeof start> | null = null
    const frames: Array<{ active: boolean; ids: string[] }> = []
    const observer = new QueryObserver<FeedData, Error, string[]>(queryClient, {
      queryKey: key,
      enabled: false,
      select: (data) => projectForumThreadsThroughActiveTagTransitions(
        queryClient,
        "forum_1",
        null,
        mapForumFeedPages(data.pages),
      ).map((post) => post.id),
    })
    const unsubscribe = observer.subscribe((result) => {
      frames.push({
        active: token ? hasForumFeedTagTransition(queryClient, token) : false,
        ids: result.data ?? [],
      })
    })
    token = start(queryClient, ["bug"], ["bug", "archived"])
    const rollbackFrameIndex = frames.length
    rollbackForumFeedTagTransition(queryClient, token)
    unsubscribe()

    expect(frames.slice(rollbackFrameIndex).every((frame) => (
      frame.ids.includes("target")
    ))).toBe(true)
    expect(hasForumFeedTagTransition(queryClient, token)).toBe(false)
    expect(ids(queryClient, null)).toEqual(["target"])
  })
})
