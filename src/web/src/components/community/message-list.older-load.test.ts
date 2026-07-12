import { describe, it, expect, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { MessageList } from "./message-list"

// Regression for the "scroll up once → loads ALL history" cascade.
//
// The top sentinel's IntersectionObserver must stay STABLE across fetch-state
// ticks. A fresh observer fires its callback immediately for an
// already-intersecting target, so if the effect re-ran on every
// `isFetchingOlder`/`onLoadOlder` change, each `fetchOlder` would recreate the
// observer, which would re-fire against the still-visible sentinel and trigger
// the next fetch — draining every older page in one go.
//
// This drives the real observer callback: intersect once, flip
// `isFetchingOlder` true→false across re-renders (what a real fetch does), and
// assert `onLoadOlder` fires exactly ONCE, not once per re-render.
describe("MessageList — older-load sentinel does not cascade", () => {
  it("fires onLoadOlder once per intersection, not on every fetch-state re-render", () => {
    // Capture the observer callback so the test can drive intersections itself.
    let ioCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null
    const mockScrollEl = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 500,
      firstElementChild: null,
      scrollTo: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
    const prevRO = g.ResizeObserver
    const prevIO = g.IntersectionObserver
    g.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    g.IntersectionObserver = class {
      // The top-sentinel observer is the one whose callback reads the
      // load-older ref guards; the bottom one is inert here (hasMoreNewer
      // false). Both share this class — capture the LAST-constructed callback,
      // which in render order is the bottom sentinel's, so instead capture the
      // FIRST (top) by only assigning once.
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        if (!ioCallback) ioCallback = cb
      }
      observe() {}
      disconnect() {}
    }

    try {
      const messages = [{ id: "m1", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }]
      const onLoadOlder = vi.fn()
      const genericMock = { willUpdate: () => {}, didUpdate: () => {}, addEventListener: () => {}, removeEventListener: () => {} }

      const render = (isFetchingOlder: boolean) =>
        React.createElement(MessageList, {
          channel: "general",
          messages,
          loading: false,
          hasMore: true,
          onLoadOlder,
          isFetchingOlder,
          onOpenThread: vi.fn(),
        })

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(render(false), {
          createNodeMock: (node) => (node.type === "div" ? mockScrollEl : genericMock),
        })
      })

      expect(ioCallback).not.toBeNull()

      // Sentinel scrolls into view → the first (and only) legitimate load.
      act(() => {
        ioCallback!([{ isIntersecting: true }])
      })
      expect(onLoadOlder).toHaveBeenCalledTimes(1)

      // A real fetchOlder flips isFetchingOlder true, then back to false when
      // the page lands. Each flip re-renders MessageList. The OLD bug
      // recreated the observer on these re-renders and re-fired against the
      // still-visible sentinel. With the stable observer, no new intersection
      // event occurs, so onLoadOlder must NOT be called again.
      act(() => {
        renderer!.update(render(true))
      })
      act(() => {
        renderer!.update(render(false))
      })
      expect(onLoadOlder).toHaveBeenCalledTimes(1)

      // While a fetch is in flight, a genuine intersection must be ignored
      // (guarded by isFetchingOlder read from the ref).
      act(() => {
        renderer!.update(render(true))
      })
      act(() => {
        ioCallback!([{ isIntersecting: true }])
      })
      expect(onLoadOlder).toHaveBeenCalledTimes(1)

      // Once the fetch settles, the next real intersection loads the next page.
      act(() => {
        renderer!.update(render(false))
      })
      act(() => {
        ioCallback!([{ isIntersecting: true }])
      })
      expect(onLoadOlder).toHaveBeenCalledTimes(2)
    } finally {
      g.ResizeObserver = prevRO
      g.IntersectionObserver = prevIO
    }
  })
})
