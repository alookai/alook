import { describe, it, expect } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useScrollAnchor } from "./use-scroll-anchor"
import type { FlatItem } from "@/components/community/message-list-items"

// Render-level coverage for something `computeHeroScrollCompensation`'s
// pure-function tests can't reach — it lives in `useScrollAnchor`'s effect
// body, not the pure delta function: the hero-swap compensation effect
// must actually adjust the real scroll container's `scrollTop`, and must
// NOT rely on `scrollMargin` doing this automatically (verified against the
// installed virtual-core source that it doesn't — see use-scroll-anchor.ts's
// module doc comment). Uses `react-test-renderer` (this repo's existing
// pattern for scroll-effect tests — see message-list.mount-identity.test.ts).

function makeMockScrollEl() {
  const el = {
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 500,
    firstElementChild: null,
    scrollTo: (opts: { top: number }) => { el.scrollTop = opts.top },
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    ownerDocument: { defaultView: {} },
  }
  return el
}

const items: FlatItem[] = [
  { kind: "message", m: { id: "m1", type: "chat", grouped: false }, key: "msg:m1" },
  { kind: "message", m: { id: "m2", type: "chat", grouped: false }, key: "msg:m2" },
]

function Harness({ heroHeight }: { heroHeight: number }) {
  const { scrollRef } = useScrollAnchor({
    items,
    initialScrollReady: true,
    heroHeight,
  })
  return React.createElement("div", { ref: scrollRef })
}

describe("useScrollAnchor — hero-swap compensation adjusts scrollTop directly (does not rely on scrollMargin alone)", () => {
  it("shoves scrollTop down by the delta when the hero grows between renders", () => {
    const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
    const prevRO = g.ResizeObserver
    const prevIO = g.IntersectionObserver
    g.ResizeObserver = class { observe() {} disconnect() {} }
    g.IntersectionObserver = class { observe() {} disconnect() {} }

    const el = makeMockScrollEl()
    try {
      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(Harness, { heroHeight: 0 }),
          { createNodeMock: () => el },
        )
      })

      // Mount consumes the one-shot gate and calls scrollToEnd — reset the
      // baseline scrollTop it left behind before asserting the hero-swap
      // delta in isolation.
      el.scrollTop = 200

      act(() => {
        renderer!.update(React.createElement(Harness, { heroHeight: 96 }))
      })

      // The hero grew by 96px — the viewer's visual position must be held
      // by shoving scrollTop down by the same amount, not left alone
      // (which is what would happen if this hook relied on `scrollMargin`
      // to do this automatically, per the verified-false original plan
      // draft claim).
      expect(el.scrollTop).toBe(200 + 96)
    } finally {
      g.ResizeObserver = prevRO
      g.IntersectionObserver = prevIO
    }
  })

  it("pulls scrollTop back up by the delta when the hero shrinks between renders", () => {
    const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
    const prevRO = g.ResizeObserver
    const prevIO = g.IntersectionObserver
    g.ResizeObserver = class { observe() {} disconnect() {} }
    g.IntersectionObserver = class { observe() {} disconnect() {} }

    const el = makeMockScrollEl()
    try {
      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(Harness, { heroHeight: 96 }),
          { createNodeMock: () => el },
        )
      })

      el.scrollTop = 300

      act(() => {
        renderer!.update(React.createElement(Harness, { heroHeight: 40 }))
      })

      expect(el.scrollTop).toBe(300 - 56)
    } finally {
      g.ResizeObserver = prevRO
      g.IntersectionObserver = prevIO
    }
  })

  it("does not touch scrollTop when heroHeight is unchanged across a re-render", () => {
    const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
    const prevRO = g.ResizeObserver
    const prevIO = g.IntersectionObserver
    g.ResizeObserver = class { observe() {} disconnect() {} }
    g.IntersectionObserver = class { observe() {} disconnect() {} }

    const el = makeMockScrollEl()
    try {
      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(Harness, { heroHeight: 60 }),
          { createNodeMock: () => el },
        )
      })

      el.scrollTop = 150

      act(() => {
        renderer!.update(React.createElement(Harness, { heroHeight: 60 }))
      })

      expect(el.scrollTop).toBe(150)
    } finally {
      g.ResizeObserver = prevRO
      g.IntersectionObserver = prevIO
    }
  })
})
