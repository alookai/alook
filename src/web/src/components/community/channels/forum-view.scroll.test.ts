import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ForumThread } from "@/lib/community/models/message"

const scrollToIndex = vi.fn()
let requestOlder: (() => void) | undefined
let sentinelEdge: string | undefined
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    options: { scrollMargin: 0 },
    scrollToIndex,
    getTotalSize: () => count * 160,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 160 })),
    measureElement: () => {},
  }),
}))
vi.mock("@/hooks/community/use-virtual-cursor-sentinel", () => ({
  useVirtualCursorSentinel: ({ onLoad, edge }: { onLoad?: () => void; edge: string }) => {
    requestOlder = onLoad
    sentinelEdge = edge
    return () => {}
  },
}))

const post = (id: string): ForumThread => ({
  id,
  name: id,
  messageCount: 1,
  lastMessageAt: "2026-08-07T00:00:00.000Z",
  parent: { authorName: "Alice", text: "root" },
  authorId: "alice",
  authorAvatar: "A",
  openerMessageId: `m_${id}`,
  tags: [],
  preview: "preview",
  participants: [],
  participantCount: 1,
})

describe("ForumView scroll anchoring", () => {
  let ForumView: typeof import("./forum-view").ForumView
  const root = { scrollHeight: 300, scrollTop: 20, clientHeight: 200 }
  const props = (posts: ForumThread[], tag = "All", loadingMore = false) => ({
    forumChannelId: "forum_1",
    members: [],
    posts,
    tag,
    loadingMore,
    onTagChange: () => {},
    onOpenPost: () => {},
    onLoadMore: vi.fn(),
  })

  beforeEach(async () => {
    vi.resetModules()
    scrollToIndex.mockReset()
    requestOlder = undefined
    sentinelEdge = undefined
    root.scrollHeight = 300
    root.scrollTop = 20
    ForumView = (await import("./forum-view")).ForumView
  })

  it("aligns the newest post to the top on first load and again after a tag switch", async () => {
    let view: ReactTestRenderer
    await act(async () => {
      view = create(createElement(ForumView, props([post("p1"), post("p2")])), {
        createNodeMock: (element) => element.props.role === "main" ? root : {},
      })
    })
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "start" })
    scrollToIndex.mockClear()
    await act(async () => { view!.update(createElement(ForumView, props([post("p3")], "bug"))) })
    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "start" })
  })

  it("loads older activity pages from the bottom sentinel without scroll-height compensation", async () => {
    const onLoadMore = vi.fn()
    let view: ReactTestRenderer
    await act(async () => {
      view = create(createElement(ForumView, { ...props([post("p3"), post("p2")]), onLoadMore }), {
        createNodeMock: (element) => element.props.role === "main" ? root : {},
      })
    })
    act(() => requestOlder?.())
    expect(sentinelEdge).toBe("end")
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    await act(async () => { view!.update(createElement(ForumView, { ...props([post("p3"), post("p2")], "All", true), onLoadMore })) })
    root.scrollHeight = 500
    await act(async () => { view!.update(createElement(ForumView, { ...props([post("p3"), post("p2"), post("p1")]), onLoadMore })) })
    expect(root.scrollTop).toBe(20)
  })
})
