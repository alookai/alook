import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { ForumSurface } from "./forum-surface"

const mocks = vi.hoisted(() => ({ readPage: vi.fn() }))
const post: ForumThread = {
  id: "existing-post", name: "Existing post", messageCount: 1,
  lastMessageAt: "2026-10-09T00:00:00.000Z",
  parent: { authorName: "Alice", text: "Body" }, authorId: "alice", authorAvatar: "A",
  openerMessageId: "opener", tags: [], preview: "Body", participants: [], participantCount: 1,
}
const page = { posts: [post], hasMore: true, nextCursor: "older" }
const queryKey = ["forum-pagination-error"]

vi.mock("@/hooks/community/use-forum-feed", async () => {
  const { useInfiniteQuery } = await import("@tanstack/react-query")
  return { useForumFeed: () => {
    const query = useInfiniteQuery({
      queryKey, queryFn: mocks.readPage, initialPageParam: null as string | null,
      initialData: { pages: [page], pageParams: [null] },
      getNextPageParam: (lastPage: typeof page) => lastPage.hasMore ? lastPage.nextCursor : undefined,
      staleTime: Infinity, retry: 1, retryDelay: 0,
    })
    return {
      ...query, posts: query.data.pages.flatMap(value => value.posts), tag: "All",
      availableTags: [], selectTag: vi.fn(), hasMoreOlder: query.hasNextPage,
      isFetchingOlder: query.isFetchingNextPage, fetchOlder: () => { void query.fetchNextPage() },
    }
  } }
})
vi.mock("@/hooks/community/use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => ({ snapshot: { lastReadSeq: 0 }, isFetching: false, error: null, retrying: false }),
}))
vi.mock("@/hooks/community/use-read-observer", () => ({ useTimelineReadObserver: vi.fn() }))
vi.mock("@/lib/community-db/projections", async (load) => ({
  ...await load<typeof import("@/lib/community-db/projections")>(),
  useCanonicalProfilesByUserId: () => new Map(),
}))
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (index: number) => string | number }) => ({
    options: { scrollMargin: 0 }, scrollToIndex: vi.fn(), getTotalSize: () => count * 160,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      key: getItemKey(index), index, start: index * 160, end: (index + 1) * 160, size: 160, lane: 0,
    })), measureElement: vi.fn(),
  }),
}))

describe("ForumSurface retained posts pagination", () => {
  afterEach(() => { mocks.readPage.mockReset() })

  it("keeps posts and stops at the boundary after native Query retries fail, then accepts recovery", async () => {
    mocks.readPage.mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise(() => {}))
    const client = new QueryClient()
    let failedCycle = false
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.query.state.status === "error" && event.query.state.fetchStatus === "idle") failedCycle = true
    })
    const tree = () => React.createElement(QueryClientProvider, { client },
      React.createElement(ForumSurface, { serverId: "server", forumChannelId: "forum", members: [], onOpenPost: vi.fn() }))
    const view = render(tree())
    try {
      await waitFor(() => expect(failedCycle).toBe(true))
      view.rerender(tree())
      expect(screen.getByTestId(tid.forumThreadTitleText(post.id))).toHaveTextContent("Existing post")
      expect(screen.queryByRole("alert")).toBeNull()
      expect(mocks.readPage).toHaveBeenCalledTimes(2)
      expect(client.getQueryState(queryKey)).toEqual(expect.objectContaining({ status: "error", fetchStatus: "idle" }))

      mocks.readPage.mockResolvedValueOnce({ ...page, hasMore: false })
      await act(async () => { await client.refetchQueries({ queryKey, exact: true }) })
      expect(mocks.readPage).toHaveBeenCalledTimes(3)
      expect(client.getQueryState(queryKey)).toEqual(expect.objectContaining({ status: "success", fetchStatus: "idle" }))
      expect(screen.getByTestId(tid.forumThreadTitleText(post.id))).toHaveTextContent("Existing post")
    } finally {
      view.unmount()
      unsubscribe()
      client.clear()
    }
  })
})
