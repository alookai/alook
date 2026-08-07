import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ForumThread } from "./_types"

const scrollToIndex = vi.fn()
let requestOlder: (() => void) | undefined
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
  useVirtualCursorSentinel: ({ onLoad }: { onLoad?: () => void }) => {
    requestOlder = onLoad
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
    root.scrollHeight = 300
    root.scrollTop = 20
    ForumView = (await import("./forum-view")).ForumView
  })

  it("aligns the newest post to the end on first load and again after a tag switch", async () => {
    let view: ReactTestRenderer
    await act(async () => {
      view = create(createElement(ForumView, props([post("p1"), post("p2")])), {
        createNodeMock: (element) => element.props.role === "main" ? root : {},
      })
    })
    expect(scrollToIndex).toHaveBeenLastCalledWith(1, { align: "end" })
    scrollToIndex.mockClear()
    await act(async () => { view!.update(createElement(ForumView, props([post("p3")], "bug"))) })
    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "end" })
  })

  it("preserves the visible rows by applying the scroll-height delta after older posts prepend", async () => {
    let view: ReactTestRenderer
    await act(async () => {
      view = create(createElement(ForumView, props([post("p2"), post("p3")])), {
        createNodeMock: (element) => element.props.role === "main" ? root : {},
      })
    })
    act(() => requestOlder?.())
    await act(async () => { view!.update(createElement(ForumView, props([post("p2"), post("p3")], "All", true))) })
    root.scrollHeight = 500
    await act(async () => { view!.update(createElement(ForumView, props([post("p1"), post("p2"), post("p3")]))) })
    expect(root.scrollTop).toBe(220)
  })
})
