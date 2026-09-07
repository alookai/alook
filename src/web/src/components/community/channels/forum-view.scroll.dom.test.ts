import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
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
  let scrollTopDescriptor: PropertyDescriptor | undefined
  let scrollHeightDescriptor: PropertyDescriptor | undefined
  let clientHeightDescriptor: PropertyDescriptor | undefined
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
    scrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
    clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")
    Object.defineProperties(HTMLElement.prototype, {
      scrollTop: {
        configurable: true,
        get: () => root.scrollTop,
        set: (value: number) => { root.scrollTop = value },
      },
      scrollHeight: { configurable: true, get: () => root.scrollHeight },
      clientHeight: { configurable: true, get: () => root.clientHeight },
    })
    ForumView = (await import("./forum-view")).ForumView
  })

  afterEach(() => {
    for (const [name, descriptor] of [
      ["scrollTop", scrollTopDescriptor],
      ["scrollHeight", scrollHeightDescriptor],
      ["clientHeight", clientHeightDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
      else delete HTMLElement.prototype[name]
    }
  })

  it("aligns the newest post to the top on first load and again after a tag switch", async () => {
    const view = render(createElement(ForumView, props([post("p1"), post("p2")])))
    expect(scrollToIndex).toHaveBeenLastCalledWith(0, { align: "start" })
    scrollToIndex.mockClear()
    view.rerender(createElement(ForumView, props([post("p3")], "bug")))
    expect(scrollToIndex).toHaveBeenCalledWith(0, { align: "start" })
  })

  it("loads older feed pages from the bottom sentinel without scroll-height compensation", async () => {
    const onLoadMore = vi.fn()
    const view = render(createElement(ForumView, { ...props([post("p3"), post("p2")]), onLoadMore }))
    act(() => requestOlder?.())
    expect(sentinelEdge).toBe("end")
    expect(onLoadMore).toHaveBeenCalledTimes(1)
    view.rerender(createElement(ForumView, { ...props([post("p3"), post("p2")], "All", true), onLoadMore }))
    root.scrollHeight = 500
    view.rerender(createElement(ForumView, { ...props([post("p3"), post("p2"), post("p1")]), onLoadMore }))
    expect(root.scrollTop).toBe(20)
  })
})
