import { describe, it, expect } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useScrollAnchor, type ScrollAnchorMessage } from "./use-scroll-anchor"

// Render-level coverage for something `decideScrollAction`'s pure-function
// tests can't reach — it lives in `useScrollAnchor`'s effect body, not the
// decision function: `compensateDelta` must return a `watchAsyncGrowth`
// cleanup (a live ResizeObserver subscription), not `undefined` — otherwise
// a prepend that triggers async image decode has nothing left to keep
// correcting scrollTop as the container keeps growing.
// Uses `react-test-renderer` (this repo's existing pattern for scroll-effect
// tests — see message-list.mount-identity.test.ts).

function Harness({ messages }: { messages: ScrollAnchorMessage[] }) {
  const { scrollRef } = useScrollAnchor({
    messages,
    initialScrollReady: true,
  })
  // `scrollRef` must attach to an actual host node — `createNodeMock` only
  // intercepts real rendered elements, not a component returning `null`.
  return React.createElement("div", { ref: scrollRef })
}

function makeMockScrollEl(initialScrollHeight: number) {
  let scrollHeight = initialScrollHeight
  const content = { tagName: "DIV" }
  const el = {
    get scrollHeight() { return scrollHeight },
    setScrollHeight(h: number) { scrollHeight = h },
    scrollTop: 0,
    clientHeight: 500,
    firstElementChild: content,
    scrollTo: (opts: { top: number }) => { el.scrollTop = opts.top },
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  return { el, content }
}

describe("useScrollAnchor — compensateDelta wires up watchAsyncGrowth", () => {
  it("keeps correcting scrollTop as the prepended content keeps growing asynchronously (not just once)", () => {
    // This repo's vitest environment is "node" (no jsdom) — `watchAsyncGrowth`
    // reaches for `window.setTimeout`/`window.clearTimeout` and the global
    // `requestAnimationFrame`/`cancelAnimationFrame`, none of which exist
    // here by default. Stub the minimum surface for this test only.
    const g = globalThis as unknown as {
      ResizeObserver: new (cb: () => void) => { observe: () => void; disconnect: () => void }
      IntersectionObserver: unknown
      window: unknown
      requestAnimationFrame: unknown
      cancelAnimationFrame: unknown
    }
    const prevRO = g.ResizeObserver
    const prevIO = g.IntersectionObserver
    const prevWindow = g.window
    const prevRaf = g.requestAnimationFrame
    const prevCaf = g.cancelAnimationFrame

    const { el, content } = makeMockScrollEl(1000)

    // `useScrollAnchor` constructs a SECOND, unrelated ResizeObserver too
    // (the "↓N below" pill recompute, observing `el` itself) — only capture
    // the one observing `el.firstElementChild` (the content wrapper), which
    // is `watchAsyncGrowth`'s.
    let capturedRoCb: (() => void) | null = null
    g.ResizeObserver = class {
      cb: () => void
      constructor(cb: () => void) { this.cb = cb }
      observe(target: unknown) {
        if (target === content) capturedRoCb = this.cb
      }
      disconnect() {}
    }
    g.IntersectionObserver = class {
      observe() {}
      disconnect() {}
    }
    g.window = { setTimeout, clearTimeout }
    // Runs the RO's scheduled action inline instead of on a real frame —
    // keeps the test synchronous.
    g.requestAnimationFrame = (cb: () => void) => { cb(); return 0 }
    g.cancelAnimationFrame = () => {}

    try {
      const messages: ScrollAnchorMessage[] = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(Harness, { messages }),
          { createNodeMock: () => el },
        )
      })

      // The mount action ALSO calls `watchAsyncGrowth` (to keep pinning to
      // the divider/bottom while images decode) — reset the capture before
      // the next commit so a stale mount-time callback can't masquerade as
      // proof that the compensateDelta branch registered its own.
      capturedRoCb = null

      // Second commit: simulate an older-messages prepend by growing
      // scrollHeight and re-rendering with a longer, head-changed list —
      // this is the commit that should take the `compensateDelta` branch.
      el.setScrollHeight(1200)
      act(() => {
        renderer!.update(
          React.createElement(Harness, {
            messages: [{ id: "m0" }, ...messages],
          }),
        )
      })

      // compensateDelta should have adjusted scrollTop synchronously...
      const afterSyncCompensation = el.scrollTop
      expect(afterSyncCompensation).toBeGreaterThan(0)

      // ...and should have registered a FRESH ResizeObserver callback of
      // its own (proving `watchAsyncGrowth` was wired from this branch,
      // not `undefined` — a stale mount-time subscription doesn't count,
      // hence the reset above).
      expect(capturedRoCb).not.toBeNull()

      // The RO's own synchronous initial callback (fired once at observe()
      // time) is skipped by design — simulate that first, no-op tick.
      act(() => {
        capturedRoCb!()
      })

      // Now simulate an image finishing async decode: the container grows
      // further AFTER the synchronous compensation already ran.
      const scrollTopBeforeAsyncGrowth = el.scrollTop
      el.setScrollHeight(el.scrollHeight + 80)
      act(() => {
        capturedRoCb!()
      })

      // The mocked `requestAnimationFrame` above runs its callback inline,
      // so `doAction` (re-measure + add only the NEW growth) has already
      // fired by the time `act` returns.
      expect(el.scrollTop).toBe(scrollTopBeforeAsyncGrowth + 80)
    } finally {
      g.ResizeObserver = prevRO
      g.IntersectionObserver = prevIO
      g.window = prevWindow
      g.requestAnimationFrame = prevRaf
      g.cancelAnimationFrame = prevCaf
    }
  })
})
