import { createElement } from "react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, mockElementGeometry, render } from "@/test/react-dom-harness"
import type { ForumThread } from "@/lib/community/models/message"
import { tid } from "@/lib/community/testids"
import { ForumView } from "./forum-view"

const posts: ForumThread[] = Array.from({ length: 100 }, (_, index) => ({
  id: `post-${index}`,
  name: `Long forum title ${index} `.repeat(6),
  parentSeq: 100 - index,
  messageCount: 1,
  lastMessageAt: "2026-10-21T00:00:00.000Z",
  parent: { authorName: "Alice", text: "root" },
  authorId: "alice",
  authorAvatar: "A",
  authorAvatarVersion: 0,
  openerMessageId: `opener-${index}`,
  tags: [],
  preview: "Preview text",
  participants: [],
  participantCount: 1,
}))
const observers = new Map<ResizeObserverCallback, Set<Element>>()
let rowHeight = (index: number) => 128 + index % 3 * 8

beforeEach(() => {
  observers.clear()
  rowHeight = (index: number) => 128 + index % 3 * 8
  vi.stubGlobal("ResizeObserver", class {
    private nodes = new Set<Element>()
    constructor(callback: ResizeObserverCallback) { observers.set(callback, this.nodes) }
    observe(node: Element) { this.nodes.add(node) }
    unobserve(node: Element) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear() }
  })
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? rowHeight(Number(this.dataset.index)) : 0
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("keeps native forum rows positioned without individual transforms across scrolling and append", () => {
  const onLoadMore = vi.fn()
  const onScrollRoot = (node: HTMLDivElement | null) => {
    if (!node) return
    mockElementGeometry(node, { clientHeight: 751, clientWidth: 390, scrollHeight: 15000 })
    Object.defineProperty(node, "scrollTo", {
      configurable: true,
      value: ({ top = 0 }: ScrollToOptions) => { node.scrollTop = top },
    })
  }
  const props = {
    forumChannelId: "forum-native-layout",
    members: [],
    posts,
    tag: "All",
    hasMore: true,
    onTagChange: () => {},
    onOpenPost: () => {},
    onLoadMore,
    onScrollRoot,
  }
  const view = render(createElement(ForumView, props))
  const root = view.getByTestId(tid.forumPostList)
  const readRows = () => Array.from(root.querySelectorAll<HTMLElement>("[data-index]"))
  expect(view.queryByTestId(tid.forumThreadCard("post-45"))).toBeNull()
  act(() => {
    root.scrollTop = 5900
    root.dispatchEvent(new Event("scroll"))
    const rows = readRows()
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.every(row => row.style.transform === "")).toBe(true)
    expect(Number.parseFloat(rows[0].style.top)).toBeLessThanOrEqual(root.scrollTop)
    const last = rows.at(-1)!
    expect(Number.parseFloat(last.style.top) + last.offsetHeight).toBeGreaterThan(root.scrollTop + root.clientHeight)
  })
  act(() => {
    for (const [callback, nodes] of observers) {
      const entries = [...nodes].filter(node => node.hasAttribute("data-index")).map<ResizeObserverEntry>(node => ({
        target: node,
        borderBoxSize: [{ blockSize: (node as HTMLElement).offsetHeight, inlineSize: 390 }],
        contentBoxSize: [{ blockSize: (node as HTMLElement).offsetHeight, inlineSize: 390 }],
        devicePixelContentBoxSize: [{ blockSize: (node as HTMLElement).offsetHeight, inlineSize: 390 }],
        contentRect: new DOMRect(0, 0, 390, (node as HTMLElement).offsetHeight),
      }))
      if (entries.length) callback(entries, {} as ResizeObserver)
    }
  })
  const previousRows = readRows()
  for (let index = 1; index < previousRows.length; index++) {
    expect(Number.parseFloat(previousRows[index].style.top)).toBe(
      Number.parseFloat(previousRows[index - 1].style.top) + previousRows[index - 1].offsetHeight,
    )
  }
  const positions = previousRows.map(row => row.style.top)
  view.rerender(createElement(ForumView, {
    ...props,
    posts: [...posts, { ...posts[0], id: "post-100", openerMessageId: "opener-100", parentSeq: 0 }],
  }))
  expect(readRows()).toEqual(previousRows)
  expect(readRows().map(row => row.style.top)).toEqual(positions)
  expect(onLoadMore).not.toHaveBeenCalled()
})


function renderUniformForum(clientHeight: number, count = posts.length) {
  rowHeight = () => 128
  const onLoadMore = vi.fn()
  const props = {
    forumChannelId: "forum-native-reserve",
    members: [],
    posts: posts.slice(0, count),
    tag: "All",
    hasMore: true,
    onTagChange: () => {},
    onOpenPost: () => {},
    onLoadMore,
    onScrollRoot: (node: HTMLDivElement | null) => {
      if (!node) return
      mockElementGeometry(node, { clientHeight, clientWidth: 390, scrollHeight: count * 128 })
      Object.defineProperty(node, "scrollTo", {
        configurable: true,
        value: ({ top = 0 }: ScrollToOptions) => { node.scrollTop = top },
      })
    },
  }
  const view = render(createElement(ForumView, props))
  return { view, props, onLoadMore, root: view.getByTestId(tid.forumPostList) }
}

it.each([320, 751, 1500])("keeps mounted rows over a %ipx viewport advance before scroll delivery", (height) => {
  const { root, onLoadMore } = renderUniformForum(height)
  const offset = 30 * 128
  for (const direction of [-1, 1]) {
    act(() => {
      root.scrollTop = offset
      root.dispatchEvent(new Event("scroll"))
    })
    const rows = [...root.querySelectorAll<HTMLElement>("[data-index]")]
    expect(rows.length).toBeLessThan(posts.length)
    root.scrollTop = offset + direction * height
    const first = rows[0]
    const last = rows.at(-1)!
    expect(Number.parseFloat(first.style.top)).toBeLessThanOrEqual(root.scrollTop)
    expect(Number.parseFloat(last.style.top) + last.offsetHeight).toBeGreaterThanOrEqual(root.scrollTop + height)
  }
  expect(onLoadMore).not.toHaveBeenCalled()
})

it("keeps the original paging boundary while rendering a larger reserve", () => {
  const { view, props, root, onLoadMore } = renderUniformForum(751, 20)
  expect(onLoadMore).not.toHaveBeenCalled()
  act(() => {
    root.scrollTop = 8 * 128
    root.dispatchEvent(new Event("scroll"))
  })
  expect(view.queryByTestId(tid.forumThreadCard("post-19"))).not.toBeNull()
  expect(onLoadMore).not.toHaveBeenCalled()
  act(() => {
    root.scrollTop = 9 * 128
    root.dispatchEvent(new Event("scroll"))
  })
  expect(onLoadMore).toHaveBeenCalledTimes(1)
  view.rerender(createElement(ForumView, props))
  expect(onLoadMore).toHaveBeenCalledTimes(1)
})
