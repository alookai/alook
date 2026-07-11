import { describe, it, expect, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { MessageList } from "./message-list"

// Confirms Phase 4's core claim with an automated test rather than relying
// solely on manual DevTools inspection: a `<MessageList>` mount effect
// fires exactly once across a `loading: true → false` prop transition on
// the SAME rendered instance (`renderer.update`, not a fresh `.create`) —
// i.e. the loading→loaded transition is a props change, not an
// unmount/remount. Uses `react-test-renderer` (works under this repo's
// `environment: "node"` vitest config, no jsdom needed) with a minimal
// `createNodeMock` scroll-container stub, since `useScrollAnchor`'s mount
// effect reads `scrollHeight`/`scrollTop`/`clientHeight` off the DOM ref.
describe("MessageList — loading→loaded mount identity (Phase 4)", () => {
  it("does not re-fire the mount-time scroll effect when transitioning loading:true → loading:false on one instance", () => {
    let scrollToCalls = 0
    const mockScrollEl = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 500,
      firstElementChild: null,
      scrollTo: () => { scrollToCalls++ },
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    const globalWithObservers = globalThis as unknown as {
      ResizeObserver: unknown
      IntersectionObserver: unknown
    }
    const prevRO = globalWithObservers.ResizeObserver
    const prevIO = globalWithObservers.IntersectionObserver
    globalWithObservers.ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    globalWithObservers.IntersectionObserver = class {
      observe() {}
      disconnect() {}
    }

    try {
      const messages = [{ id: "m1", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }]

      let renderer: TestRenderer.ReactTestRenderer
      // `createNodeMock` is called for EVERY host node react-test-renderer
      // renders, not just the scroll container — including the
      // `<number-flow-react>` custom element the "↓ N" pill's `NumberTicker`
      // renders. That element's class-component wrapper (`NumberFlowImpl`)
      // calls `this.el?.willUpdate()`/`didUpdate()` on its ref whenever the
      // `data` prop changes (see `@number-flow/react`'s
      // `getSnapshotBeforeUpdate`) — the virtualized `belowCount` now
      // computes synchronously from virtualizer state, so it can change
      // value between the two renders below, unlike the pre-virtualization
      // version (computed async, stayed 0 across both renders in this
      // test). Discriminate by node type so only the real scroll `<div>`
      // gets the full scroll-container mock; everything else gets a no-op
      // stub with the handful of methods any wrapped custom element might
      // call.
      const genericMock = { willUpdate: () => {}, didUpdate: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(MessageList, { channel: "general", messages: [], loading: true, onOpenThread: vi.fn() }),
          { createNodeMock: (node) => (node.type === "div" ? mockScrollEl : genericMock) },
        )
      })

      // The mount-time initial-scroll action fires once on the initial
      // mount (with 0 messages, `decideScrollAction` bails without firing —
      // see the "does not fire on an empty message list" case in
      // `use-scroll-anchor.test.ts` — so `scrollToCalls` is 0 here).
      const callsBeforeLoaded = scrollToCalls

      act(() => {
        renderer!.update(
          React.createElement(MessageList, { channel: "general", messages, loading: false, onOpenThread: vi.fn() }),
        )
      })

      // The mount effect fires exactly once total, on this SAME instance,
      // when real messages arrive — not twice (which is what a hidden
      // remount would look like: the effect firing once per instance).
      expect(scrollToCalls).toBe(callsBeforeLoaded + 1)

      // A second update with the same messages must NOT re-fire the
      // one-shot mount action again (confirms the gate persisted across
      // the prop transition — a real remount would reset it, and this
      // assertion would then fail with `scrollToCalls` incrementing again).
      act(() => {
        renderer!.update(
          React.createElement(MessageList, { channel: "general", messages, loading: false, onOpenThread: vi.fn() }),
        )
      })
      expect(scrollToCalls).toBe(callsBeforeLoaded + 1)
    } finally {
      globalWithObservers.ResizeObserver = prevRO
      globalWithObservers.IntersectionObserver = prevIO
    }
  })
})
