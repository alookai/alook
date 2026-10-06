import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@/test/react-dom-harness"
import { ApiError } from "@/lib/errors"
import { ForumView } from "./forum-view"
import { ForumSurface } from "./forum-surface"

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  read: { snapshot: { lastReadMessageId: "opener-old", lastReadAt: "t", lastReadSeq: 2 }, isFetching: false, error: null as Error | null, retrying: false, retry: vi.fn(() => Promise.resolve()) },
  feed: {
    posts: [
      {
        id: "child-a",
        name: "A",
        messageCount: 0,
        lastMessageAt: "t1",
        parent: { authorName: "Alice", text: "" },
        authorId: "alice",
        authorAvatar: "A",
        openerMessageId: "opener-a",
        openerCreatedAt: "2026-08-27T01:00:00.000Z",
        parentSeq: 3,
        tags: [],
        preview: "",
        participants: [],
        participantCount: 1,
      },
      {
        id: "legacy-child",
        name: "Legacy",
        messageCount: 0,
        lastMessageAt: "t0",
        parent: { authorName: "", text: "" },
        authorId: "",
        authorAvatar: "",
        openerMessageId: "",
        tags: [],
        preview: "",
        participants: [],
        participantCount: 0,
      },
    ],
    error: null as Error | null,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isError: false,
    refetch: vi.fn(() => Promise.resolve()),
    tag: "All",
    availableTags: [],
    selectTag: vi.fn(),
    hasMoreOlder: false,
    isFetchingOlder: false,
    fetchOlder: vi.fn(),
  },
}))

vi.mock("@tanstack/react-query", async (load) => ({ ...await load<typeof import("@tanstack/react-query")>(), useQueryClient: () => ({ refetchQueries: mocks.read.retry }) }))

vi.mock("@/hooks/community/use-forum-feed", () => ({
  useForumFeed: () => mocks.feed,
}))
vi.mock("@/hooks/community/use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => mocks.read,
}))
vi.mock("@/hooks/community/use-read-observer", () => ({
  useTimelineReadObserver: (value: unknown) => mocks.observe(value),
}))
vi.mock("./forum-view", () => ({
  ForumView: vi.fn(() => null),
}))

describe("ForumSurface generic read-row adapter", () => {
  it("keeps cold failure Retry visible through a deduplicated retry and recovers to the list", async () => {
    Object.assign(mocks.feed, { posts: [], isError: true, error: new Error("deadline") })
    let release!: () => void
    mocks.feed.refetch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const props = { serverId: "server-1", forumChannelId: "forum-1", members: [], onOpenPost: vi.fn() }
    const rendered = render(React.createElement(ForumSurface, props))
    expect(screen.getByRole("alert")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(mocks.feed.refetch).toHaveBeenCalledOnce()
    expect(mocks.read.retry).toHaveBeenCalledOnce()
    Object.assign(mocks.feed, { isError: false, error: null, isFetching: true })
    rendered.rerender(React.createElement(ForumSurface, props))
    expect(screen.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Retrying…" }))
    expect(mocks.feed.refetch).toHaveBeenCalledOnce()
    await act(async () => { release() })
    Object.assign(mocks.feed, { posts: mocks.feed.posts.concat(posts), isFetching: false })
    rendered.rerender(React.createElement(ForumSurface, props))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(ForumView).toHaveBeenLastCalledWith(expect.objectContaining({ posts }), undefined)
    rendered.unmount()
  })

  it("retains readable posts during transient feed and read failures", () => {
    Object.assign(mocks.feed, { isError: true, error: new Error("offline") })
    mocks.read.error = new Error("offline")
    const rendered = render(React.createElement(ForumSurface, { serverId: "server-1", forumChannelId: "forum-1", members: [], onOpenPost: vi.fn() }))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(ForumView).toHaveBeenCalled()
    rendered.unmount()
  })

  it.each(["feed", "read"])("suppresses cached posts and watermark after %s access denial", (source) => {
    if (source === "feed") Object.assign(mocks.feed, { isError: true, error: new ApiError("denied", 403) })
    else mocks.read.error = new ApiError("denied", 403)
    const rendered = render(React.createElement(ForumSurface, { serverId: "server-1", forumChannelId: "forum-1", members: [], onOpenPost: vi.fn() }))
    expect(screen.getByRole("alert")).toBeDefined()
    expect(ForumView).not.toHaveBeenCalled()
    expect(mocks.observe).toHaveBeenLastCalledWith(expect.objectContaining(source === "feed" ? { feedStatus: "error" } : { snapshotStatus: "error" }))
    rendered.unmount()
  })

  const posts = mocks.feed.posts
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks.feed, { posts, error: null, isError: false, isFetching: false, isLoading: false, isPending: false })
    Object.assign(mocks.read, { error: null, isFetching: false, retrying: false })
  })

  it("projects canonical opener candidates and binds only the list viewport", () => {
    const rendered = render(React.createElement(ForumSurface, {
      serverId: "server-1",
      forumChannelId: "forum-1",
      members: [],
      onOpenPost: vi.fn(),
    }))

    expect(mocks.observe).toHaveBeenLastCalledWith({
      channelId: "forum-1",
      messages: [{
        id: "opener-a",
        seq: 3,
        authorId: "alice",
        createdAt: "2026-08-27T01:00:00.000Z",
      }],
      scrollRootEl: null,
      snapshotStatus: "ready",
      feedStatus: "ready",
      tailAttached: true,
      confirmedSeq: 2,
      catchUp: expect.any(Function),
    })

    const root = {} as HTMLDivElement
    const viewProps = vi.mocked(ForumView).mock.calls.at(-1)![0]
    act(() => viewProps.onScrollRoot?.(root))
    expect(mocks.observe).toHaveBeenLastCalledWith(expect.objectContaining({
      channelId: "forum-1",
      scrollRootEl: root,
    }))

    rendered.unmount()
  })
})
