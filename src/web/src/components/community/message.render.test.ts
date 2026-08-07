import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Message } from "./message"
import type { RenderMsg } from "./_types"

// WS3 render-behavior tests (see plans/community-switch-perf-optimization.md):
// - the custom memo comparator bails out despite the per-render `m` clone,
// - but does NOT drop legit content/reaction/thread updates,
// - and overlay roots are lazily mounted (bare row until activated).
//
// Uses react-test-renderer under the repo's node env (no jsdom / @testing-
// library), matching message-list.mount-identity.test.ts.

function baseMsg(over: Partial<RenderMsg> = {}): RenderMsg {
  return {
    id: "m1",
    type: "chat",
    authorId: "u1",
    authorName: "Alice",
    content: "hello",
    createdAt: new Date(0).toISOString(),
    grouped: false,
    ...over,
  }
}

const genericMock = {
  willUpdate: () => {}, didUpdate: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
}

let renderCount = 0
// Message consumes query context (the lazy Mark/Unmark state read), so every
// render tree is wrapped in a provider. A single shared client keeps the
// wrapper element type stable across `.update()` so the memo behavior under
// test isn't disturbed. Retries off + no network — the query stays idle
// (`enabled` only flips true once a menu opens, which these trees don't do).
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function makeTree(props: Parameters<typeof Message>[0]) {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(Message, props),
  )
}

beforeEach(() => {
  renderCount = 0
  const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  g.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("Message memo comparator", () => {
  it("bails out when compared fields are unchanged despite a fresh `m` clone", () => {
    const onOpenThread = vi.fn()
    const stableProps = { onOpenThread }
    // Spy on the resolver: it's called during render, so call count tracks renders.
    const resolveUserName = vi.fn((id: string) => id)

    let renderer: TestRenderer.ReactTestRenderer
    const m1 = baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] })
    act(() => {
      renderer = TestRenderer.create(
        makeTree({ m: m1, resolveUserName, ...stableProps }),
        { createNodeMock: () => genericMock },
      )
    })
    const callsAfterFirst = resolveUserName.mock.calls.length

    // Re-render with a NEW clone that is field-equal (the message-list-items
    // clone pattern: { ...m }). Comparator must bail → resolver not called again.
    act(() => {
      renderer!.update(makeTree({ m: { ...m1 }, resolveUserName, ...stableProps }))
    })
    expect(resolveUserName.mock.calls.length).toBe(callsAfterFirst)
  })

  it("re-renders when content changes (edit)", () => {
    const onOpenThread = vi.fn()
    const resolveUserName = vi.fn((id: string) => id)
    let renderer: TestRenderer.ReactTestRenderer
    const m1 = baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] })
    act(() => {
      renderer = TestRenderer.create(
        makeTree({ m: m1, resolveUserName, onOpenThread }),
        { createNodeMock: () => genericMock },
      )
    })
    const before = resolveUserName.mock.calls.length
    act(() => {
      renderer!.update(makeTree({ m: { ...m1, content: "edited" }, resolveUserName, onOpenThread }))
    })
    expect(resolveUserName.mock.calls.length).toBeGreaterThan(before)
  })

  it("re-renders when reactions change", () => {
    const onOpenThread = vi.fn()
    const resolveUserName = vi.fn((id: string) => id)
    let renderer: TestRenderer.ReactTestRenderer
    const m1 = baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] })
    act(() => {
      renderer = TestRenderer.create(
        makeTree({ m: m1, resolveUserName, onOpenThread }),
        { createNodeMock: () => genericMock },
      )
    })
    const before = resolveUserName.mock.calls.length
    act(() => {
      renderer!.update(makeTree({
        m: { ...m1, reactions: [{ emoji: "👍", count: 2, me: true, userIds: ["u2", "u3"] }] },
        resolveUserName, onOpenThread,
      }))
    })
    expect(resolveUserName.mock.calls.length).toBeGreaterThan(before)
  })
})

describe("Message lazy overlays", () => {
  it("does not mount the ContextMenu root until the row is activated", () => {
    const onOpenThread = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        // interactive requires a menu handler present + not compact
        makeTree({ m: baseMsg(), onOpenThread, onReply: () => {}, onReact: () => {} }),
        { createNodeMock: () => genericMock },
      )
    })
    // Before activation: the row renders but the ContextMenu content
    // (MessageContextItems) is not in the tree. We assert no element carries the
    // context-menu content marker by checking the rendered JSON has no
    // "ContextMenu"-typed node. A cheap structural proxy: the "Add reaction"
    // toolbar (only mounted when activated) is absent.
    const json = renderer!.toJSON()
    const tree = JSON.stringify(json)
    // The reaction-add testid only renders inside the activated toolbar.
    expect(tree).not.toContain("reaction-add")
  })

  it("keeps failed-message dismiss independent from retry", () => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        makeTree({ m: baseMsg({ failed: true }), onOpenThread: vi.fn(), onRetry, onDismiss }),
        { createNodeMock: () => genericMock },
      )
    })

    const dismiss = renderer!.root.findAllByType("button")
      .find((button) => button.children.includes("Dismiss"))
    expect(dismiss).toBeDefined()
    act(() => dismiss!.props.onClick())

    expect(onDismiss).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })
})
