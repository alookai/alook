import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMessageMenuPointAnchor,
  Message,
  messageCanShare,
  selectionBelongsToRow,
  shouldActivateMessageOverlays,
  shouldSuppressTouchMenuOpen,
} from "./message"
import type { RenderMsg } from "@/lib/community/models/message"

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

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === "string" ? child : textContent(child)
  )).join("")
}

beforeEach(() => {
  renderCount = 0
  const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  g.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

describe("Message reply content projection", () => {
  it("keeps the reply header and renders only the projected Markdown body", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({
          content: "@Bob Smith\n**visible** body",
          replyTo: { id: "prior", authorName: "Bob Smith", text: "original" },
        }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const body = renderer!.root.findByProps({ "data-community-message-body": true })
    expect(textContent(body)).not.toContain("@Bob Smith")
    expect(textContent(body)).toContain("visible")
    expect(renderer!.root.findAllByType("button").some((button) => (
      textContent(button).includes("@Bob Smith")
      && textContent(button).includes("original")
    ))).toBe(true)
  })

  it("keeps a different leading mention visible and hides prefix-only reply text", () => {
    let different: TestRenderer.ReactTestRenderer
    act(() => {
      different = TestRenderer.create(makeTree({
        m: baseMsg({
          content: "@Carol\nhello",
          replyTo: { id: "prior", authorName: "Bob", text: "original" },
        }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    const body = different!.root.findByProps({ "data-community-message-body": true })
    expect(textContent(body)).toContain("@Carol")

    expect(messageCanShare(baseMsg({
      content: "@Bob\n",
      replyTo: { id: "prior", authorName: "Bob", text: "original" },
    }))).toBe(false)
  })
})

describe("Message touch action menu", () => {
  it("creates a zero-size virtual anchor at the viewport click coordinates", () => {
    const rect = createMessageMenuPointAnchor(123, 456).getBoundingClientRect()

    expect(rect).toMatchObject({
      x: 123,
      y: 456,
      top: 456,
      right: 123,
      bottom: 456,
      left: 123,
      width: 0,
      height: 0,
    })
  })

  it("uses row taps with an invisible dropdown anchor and no persistent ellipsis", async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg(),
          hoverCapable: false,
          onOpenThread: vi.fn(),
          onReply: vi.fn(),
          onCopy: vi.fn(),
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const triggers = renderer!.root.findAll(
      (node) => node.props["data-slot"] === "dropdown-menu-trigger",
    )
    const trigger = triggers.find((node) => node.type === "button")
    expect(trigger).toBeDefined()
    expect(trigger?.props["aria-hidden"]).toBe(true)
    expect(trigger?.props.tabIndex).toBe(-1)
    expect(trigger?.props.className).toContain("size-0")
    expect(trigger?.findAll((node) => node.type === "svg")).toHaveLength(0)
    expect(renderer!.root.findAll(
      (node) => node.props["data-slot"] === "context-menu-trigger",
    )).toHaveLength(0)

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    expect(row.props.className).not.toContain("pr-11")
    expect(row.props.className).not.toContain("select-none")
    expect(row.props.role).toBeUndefined()
    expect(row.props.tabIndex).toBeUndefined()
    act(() => renderer!.unmount())
  })

  it("anchors an accepted row tap to its viewport coordinates", async () => {
    vi.stubGlobal("window", { getSelection: () => null })
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg({ content: "long message\n".repeat(200) }),
          hoverCapable: false,
          onOpenThread: vi.fn(),
          onReply: vi.fn(),
          onCopy: vi.fn(),
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    await act(async () => {
      row.props.onClick({
        clientX: 271,
        clientY: 603,
        currentTarget: { contains: () => false },
        target: { closest: () => null },
      })
    })

    const positioner = renderer!.root.find(
      (node) => node.props.positionMethod === "fixed" && node.props.anchor,
    )
    expect(positioner.props.anchor.getBoundingClientRect()).toMatchObject({
      x: 271,
      y: 603,
      width: 0,
      height: 0,
    })
    expect(positioner.props.collisionPadding).toBe(8)
    expect(positioner.props.collisionAvoidance).toEqual({
      side: "flip",
      align: "shift",
      fallbackAxisSide: "none",
    })
    act(() => renderer!.unmount())
  })

  it("lets a short row tap reach the menu but suppresses long-press, selection, and nested-control taps", () => {
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: false, longPress: false,
    })).toBe(false)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: false, longPress: true,
    })).toBe(true)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: false, selectionInsideRow: true, longPress: false,
    })).toBe(true)
    expect(shouldSuppressTouchMenuOpen({
      nestedControl: true, selectionInsideRow: false, longPress: false,
    })).toBe(true)
  })

  it("overrides the app-wide iOS callout suppression on selectable message text", async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg(),
          hoverCapable: false,
          onOpenThread: vi.fn(),
          onReply: vi.fn(),
        }),
        { createNodeMock: () => genericMock },
      )
    })

    const body = renderer!.root.findByProps({ "data-community-message-body": true })
    expect(body.props.className).toContain("select-text")
    const globalCss = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8")
    expect(globalCss).toMatch(
      /\[data-community-message-body\]\s*\{[^}]*-webkit-touch-callout:\s*default;[^}]*user-select:\s*text;/s,
    )
    act(() => renderer!.unmount())
  })
})

describe("Message desktop text selection", () => {
  const insideAnchor = {} as Node
  const insideFocus = {} as Node
  const outside = {} as Node
  const rowElement = {
    contains: (node: Node | null) => node === insideAnchor || node === insideFocus,
  }

  it("recognizes a non-collapsed selection with either endpoint inside the row", () => {
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: insideAnchor,
      focusNode: outside,
    }, rowElement)).toBe(true)
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: insideFocus,
    }, rowElement)).toBe(true)
  })

  it("rejects collapsed and outside-row selections", () => {
    expect(selectionBelongsToRow({
      isCollapsed: true,
      anchorNode: insideAnchor,
      focusNode: insideFocus,
    }, rowElement)).toBe(false)
    expect(selectionBelongsToRow({
      isCollapsed: false,
      anchorNode: outside,
      focusNode: outside,
    }, rowElement)).toBe(false)
    expect(selectionBelongsToRow(null, rowElement)).toBe(false)
  })

  it("preserves the native context menu for a selection inside the row", () => {
    vi.stubGlobal("window", {
      getSelection: () => ({
        isCollapsed: false,
        anchorNode: insideAnchor,
        focusNode: insideFocus,
      }),
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )

    const stopPropagation = vi.fn()
    const preventDefault = vi.fn()
    act(() => row.props.onContextMenuCapture({
      currentTarget: rowElement,
      stopPropagation,
      preventDefault,
    }))

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(preventDefault).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
  })

  it("keeps Alook's context menu for a row with no active selection", () => {
    vi.stubGlobal("window", { getSelection: () => null })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )

    const stopPropagation = vi.fn()
    const preventDefault = vi.fn()
    act(() => row.props.onContextMenuCapture({
      currentTarget: rowElement,
      stopPropagation,
      preventDefault,
    }))

    expect(stopPropagation).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    act(() => renderer!.unmount())
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
      width: 640, height: 480,
    })
  })
})

describe("Message file attachment", () => {
  it("opens previewable files through the shared attachment card", () => {
    const onPreviewAttachment = vi.fn()
    const file = {
      kind: "file" as const,
      name: "notes.md",
      url: "/notes",
      contentType: "text/markdown",
      sizeBytes: 128,
      size: "128 B",
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ attachments: [file] }),
        onOpenThread: vi.fn(),
        onPreviewAttachment,
      }), { createNodeMock: () => genericMock })
    })
    const card = renderer!.root.findByProps({ "data-testid": "community-attachment-card-notes.md" })
    act(() => card.props.onClick())
    expect(onPreviewAttachment).toHaveBeenCalledWith(file)
  })

  it("renders media through the shared progressive-disclosure block", () => {
    const media = {
      kind: "file" as const,
      name: "voice.ogg",
      url: "/voice",
      contentType: "audio/ogg",
      sizeBytes: 256,
      size: "256 B",
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ attachments: [media] }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    expect(renderer!.root.findByProps({ "data-testid": "community-media-block-voice.ogg" }).props["data-media-kind"])
      .toBe("audio")
    expect(renderer!.root.findAllByType("audio")).toHaveLength(0)
  })
})

describe("Message lazy overlays", () => {
  it("does not remount the row when the pointer enters an author button", () => {
    const interactiveTarget = { closest: vi.fn(() => ({})) }
    const rowTarget = { closest: vi.fn(() => null) }

    expect(shouldActivateMessageOverlays(interactiveTarget as unknown as EventTarget)).toBe(false)
    expect(shouldActivateMessageOverlays(rowTarget as unknown as EventTarget)).toBe(true)
  })

  it("keeps the first author click live while lazy overlays are inactive", () => {
    const onOpenProfile = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        makeTree({
          m: baseMsg(),
          onOpenThread: vi.fn(),
          onOpenProfile,
          onReply: vi.fn(),
        }),
        { createNodeMock: () => genericMock },
      )
    })
    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const authorButton = renderer!.root.findAllByType("button").find((button) =>
      button.children.includes("Alice"),
    )
    const target = { closest: () => authorButton }

    act(() => row.props.onPointerEnter({ target }))
    expect(renderer!.root.findAll(
      (node) => node.props["data-slot"] === "context-menu-trigger",
    )).toHaveLength(0)

    const event = { clientX: 10, clientY: 20 }
    act(() => authorButton!.props.onClick(event))
    expect(onOpenProfile).toHaveBeenCalledOnce()
    expect(onOpenProfile).toHaveBeenCalledWith("Alice", event, undefined, "u1")
  })

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
