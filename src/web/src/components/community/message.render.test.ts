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

describe("Message image attachment layout", () => {
  it("keeps a known portrait image intrinsic and constrains it by message width + max height", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg({
            attachments: [{
              kind: "image",
              name: "portrait.png",
              url: "/portrait.png",
              width: 396,
              height: 702,
            }],
          }),
          onOpenThread: vi.fn(),
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const image = renderer!.root.findByType("img")
    expect(image.props.src).toBe("/portrait.png")
    expect(image.props).toMatchObject({ width: 396, height: 702 })
    expect(image.props.className).toContain("h-auto")
    expect(image.props.className).toContain("w-auto")
    expect(image.props.className).toContain("max-h-75")
    expect(image.props.className).toContain("max-w-full")
    expect(image.parent?.props.className).toContain("w-fit")
    expect(image.parent?.props.className).toContain("max-w-full")
  })

  it("loads the canonical thumbnail in-list and opens the original identity on click", () => {
    const onPreviewImage = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ attachments: [{
          kind: "image", name: "photo.png", url: "/original", thumbnailUrl: "/thumbnail",
          width: 640, height: 480,
        }] }),
        onOpenThread: vi.fn(),
        onPreviewImage,
      }), { createNodeMock: () => genericMock })
    })
    const image = renderer!.root.findByType("img")
    expect(image.props.src).toBe("/thumbnail")
    expect(image.props.loading).toBe("lazy")
    act(() => image.parent!.props.onClick())
    expect(onPreviewImage).toHaveBeenCalledWith({
      originalUrl: "/original", thumbnailUrl: "/thumbnail", name: "photo.png",
    })
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

  it.each([
    ["Retry", (onRetry: ReturnType<typeof vi.fn>, _onDismiss: ReturnType<typeof vi.fn>) => onRetry],
    ["Dismiss", (_onRetry: ReturnType<typeof vi.fn>, onDismiss: ReturnType<typeof vi.fn>) => onDismiss],
  ])("keeps a failed row out of lazy overlays so pointerenter → first %s click fires once", (label, expectedCallback) => {
    const onRetry = vi.fn()
    const onDismiss = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg({ failed: true }),
          onOpenThread: vi.fn(),
          onCopy: vi.fn(),
          onRetry,
          onDismiss,
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    expect(row.props.onPointerEnter).toBeUndefined()
    act(() => row.props.onPointerEnter?.())
    expect(renderer!.root.findAll(
      (node) => node.props["data-slot"] === "context-menu-trigger",
    )).toHaveLength(0)

    const action = renderer!.root.findAllByType("button").find((button) =>
      label === "Dismiss"
        ? button.children.includes("Dismiss")
        : button.children.some((child) => typeof child === "string" && child.includes("Message failed to send")),
    )
    expect(action).toBeDefined()
    act(() => action!.props.onClick())

    expect(expectedCallback(onRetry, onDismiss)).toHaveBeenCalledOnce()
    const otherCallback = label === "Dismiss" ? onRetry : onDismiss
    expect(otherCallback).not.toHaveBeenCalled()
  })
})
