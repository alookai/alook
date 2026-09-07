import { afterEach, describe, it, expect, vi } from "vitest"
import React from "react"
import { MessageList } from "./message-list"
import { render } from "@/test/react-dom-harness"

vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("span", null, value),
}))

let scrollToDescriptor: PropertyDescriptor | undefined

// Confirms Phase 4's core claim with an automated test rather than relying
// solely on manual DevTools inspection: a `<MessageList>` mount effect
// fires exactly once across a `loading: true → false` prop transition on
// the SAME rendered DOM instance — i.e. the loading→loaded transition is a
// props change, not an unmount/remount.
describe("MessageList — loading→loaded mount identity (Phase 4)", () => {
  afterEach(() => {
    if (scrollToDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", scrollToDescriptor)
    } else {
      delete (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("does not re-fire the mount-time scroll effect when transitioning loading:true → loading:false on one instance", () => {
    const scrollTo = vi.fn()
    scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo")
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    })
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500)
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    const messages = [{ id: "m1", authorName: "Alice", content: "hi", createdAt: new Date(0).toISOString() }]
    const renderer = render(
      React.createElement(MessageList, {
        channel: "general",
        messages: [],
        loading: true,
        onOpenThread: vi.fn(),
      }),
    )

    // The initial mount has no messages, so the one-shot action bails.
    const callsBeforeLoaded = scrollTo.mock.calls.length

    renderer.rerender(
      React.createElement(MessageList, {
        channel: "general",
        messages,
        loading: false,
        onOpenThread: vi.fn(),
      }),
    )

    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeLoaded + 1)

    renderer.rerender(
      React.createElement(MessageList, {
        channel: "general",
        messages,
        loading: false,
        onOpenThread: vi.fn(),
      }),
    )
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeLoaded + 1)
  })
})
