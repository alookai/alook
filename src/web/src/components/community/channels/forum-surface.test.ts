import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ForumView } from "./forum-view"
import { ForumSurface } from "./forum-surface"

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
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

vi.mock("@/hooks/community/use-forum-feed", () => ({
  useForumFeed: () => mocks.feed,
}))
vi.mock("@/hooks/community/use-channel-read-state", () => ({
  useChannelReadStateSnapshot: () => ({
    snapshot: { lastReadMessageId: "opener-old", lastReadAt: "t", lastReadSeq: 2 },
    isFetching: false,
  }),
}))
vi.mock("@/hooks/community/use-read-observer", () => ({
  useTimelineReadObserver: (value: unknown) => mocks.observe(value),
}))
vi.mock("./forum-view", () => ({
  ForumView: vi.fn(() => null),
}))

describe("ForumSurface generic read-row adapter", () => {
  beforeEach(() => vi.clearAllMocks())

  it("projects canonical opener candidates and binds only the list viewport", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(ForumSurface, {
        serverId: "server-1",
        forumChannelId: "forum-1",
        members: [],
        onOpenPost: vi.fn(),
      }))
    })

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

    act(() => renderer!.unmount())
  })
})
