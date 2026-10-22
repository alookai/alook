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

it("keeps a new Forum instance at the start through hidden mounting and positive-size delivery", () => {
  let visible = false
  rowHeight = () => visible ? 160 : 0
  const writes: number[] = []
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(++frameId, callback); return frameId })
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id) })
  const props = {
    forumChannelId: "forum-hidden-return", members: [], posts: posts.slice(0, 15), tag: "All",
    onTagChange: () => {}, onOpenPost: () => {},
    onScrollRoot: (node: HTMLDivElement | null) => {
      if (!node) return
      Object.defineProperties(node, {
        clientWidth: { configurable: true, get: () => visible ? 390 : 0 },
        clientHeight: { configurable: true, get: () => visible ? 751 : 0 },
        scrollHeight: { configurable: true, get: () => visible ? Math.max(node.clientHeight, (Number.parseFloat((node.firstElementChild as HTMLElement)?.style.height ?? "0") || 0) + 16) : 0 },
        scrollTo: { configurable: true, value: ({ top = 0 }: ScrollToOptions) => {
          node.scrollTop = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight))
          writes.push(node.scrollTop)
        } },
      })
    },
  }
  const enter = () => {
    const view = render(createElement(ForumView, props))
    const root = view.getByTestId(tid.forumPostList)
    visible = true
    for (let pass = 0; pass < 4; pass++) act(() => {
      for (const [callback, nodes] of [...observers]) {
        const entries = [...nodes].map<ResizeObserverEntry>(node => {
          const height = node.hasAttribute("data-index") ? rowHeight(Number((node as HTMLElement).dataset.index)) : 751
          return { target: node, borderBoxSize: [{ blockSize: height, inlineSize: 390 }], contentBoxSize: [{ blockSize: height, inlineSize: 390 }], devicePixelContentBoxSize: [], contentRect: new DOMRect(0, 0, 390, height) }
        })
        if (entries.length) callback(entries, {} as ResizeObserver)
      }
      root.dispatchEvent(new Event("scroll"))
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(performance.now())
    })
    expect(root.scrollHeight).toBeGreaterThan(root.clientHeight)
    expect(root.scrollTop).toBe(0)
    expect(root.querySelector("[data-index]")).toHaveAttribute("data-index", "0")
    expect(writes.every(offset => offset === 0)).toBe(true)
    return { view, root }
  }
  const first = enter()
  act(() => { first.root.scrollTop = 700; first.root.dispatchEvent(new Event("scroll")) })
  const measuredHeight = first.root.scrollHeight
  act(() => {
    for (const [callback, nodes] of [...observers]) {
      const entries = [...nodes].filter(node => node.hasAttribute("data-index")).map<ResizeObserverEntry>(node => ({
        target: node, borderBoxSize: [{ blockSize: 0, inlineSize: 0 }], contentBoxSize: [{ blockSize: 0, inlineSize: 0 }], devicePixelContentBoxSize: [], contentRect: new DOMRect(),
      }))
      if (entries.length) callback(entries, {} as ResizeObserver)
    }
  })
  expect(first.root.scrollHeight).toBe(measuredHeight)
  expect(first.root.scrollTop).toBe(700)
  first.view.unmount()
  visible = false
  writes.length = 0
  const returned = enter()
  expect(returned.root).not.toBe(first.root)
  returned.view.unmount()
})
