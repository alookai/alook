import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMessageMenuPointAnchor,
  Message,
  messageCanShare,
  messageEventBelongsToRow,
  messageLinkClickUsesMenu,
  messageLinkPointerType,
  selectionBelongsToRow,
  shouldAdoptDesktopMenuInput,
  shouldActivateMessageOverlays,
  shouldSuppressTouchMenuOpen,
} from "./message"
import { EmojiPickerPopover } from "./emoji-picker"
import type { RenderMsg } from "@/lib/community/models/message"
import { useCommunityWsStore } from "@/stores/community/ws"

vi.mock("./emoji-picker", async () => {
  const ReactModule = await import("react")
  function MockEmojiPickerPopover({
    children,
    onPick,
    ...props
  }: {
    children: React.ReactElement
    onPick: (emoji: string) => void
    side?: string
    align?: string
  }) {
    const [open, setOpen] = ReactModule.useState(false)
    return ReactModule.createElement(
      "mock-emoji-picker-popover",
      { ...props, onPick, open },
      ReactModule.cloneElement(children, {
        "data-slot": "popover-trigger",
        onClick: () => setOpen(true),
      } as React.HTMLAttributes<HTMLElement>),
      open
        ? ReactModule.createElement("mock-emoji-picker-content", { "data-slot": "popover-content" })
        : null,
    )
  }
  return { EmojiPickerPopover: MockEmojiPickerPopover }
})

vi.mock("@/components/ui/tooltip", async () => {
  const ReactModule = await import("react")
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("mock-tooltip", null, children),
    TooltipTrigger: ({
      render,
      children,
      ...props
    }: {
      render: React.ReactElement
      children?: React.ReactNode
    }) => ReactModule.cloneElement(render, {
      ...props,
      "data-slot": "tooltip-trigger",
    } as React.HTMLAttributes<HTMLElement>, children ?? render.props.children),
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("mock-tooltip-content", null, children),
  }
})

vi.mock("@/components/ui/context-menu", async () => {
  const ReactModule = await import("react")
  return {
    ContextMenu: ({ children, ...props }: { children: React.ReactNode }) =>
      ReactModule.createElement("mock-context-menu", props, children),
    ContextMenuTrigger: ({
      render,
      ...props
    }: {
      render: React.ReactElement
    }) => ReactModule.cloneElement(render, {
      ...props,
      className: [render.props.className, props.className].filter(Boolean).join(" "),
      "data-slot": "context-menu-trigger",
    } as React.HTMLAttributes<HTMLElement>),
    ContextMenuContent: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement("mock-context-menu-content", null, children),
    ContextMenuItem: ({
      children,
      ...props
    }: {
      children: React.ReactNode
    }) => ReactModule.createElement("button", { ...props, "data-slot": "context-menu-item" }, children),
    ContextMenuSeparator: (props: Record<string, unknown>) =>
      ReactModule.createElement("mock-context-menu-separator", {
        ...props,
        "data-slot": "context-menu-separator",
      }),
  }
})

vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const ReactModule = await import("react")
  const actual = await importOriginal<typeof import("@/components/ui/dropdown-menu")>()
  return {
    ...actual,
    DropdownMenu: ({ children, ...props }: { children: React.ReactNode }) =>
      ReactModule.createElement("mock-dropdown-menu", props, children),
    DropdownMenuTrigger: ({
      render,
      children,
      ...props
    }: {
      render: React.ReactElement
      children?: React.ReactNode
    }) => ReactModule.cloneElement(render, {
      ...props,
      "data-slot": "dropdown-menu-trigger",
    } as React.HTMLAttributes<HTMLElement>, children ?? render.props.children),
    DropdownMenuContent: ({
      children,
      ...props
    }: {
      children: React.ReactNode
      [key: string]: unknown
    }) => ReactModule.createElement(
      "mock-dropdown-menu-positioner",
      props,
      ReactModule.createElement("mock-dropdown-menu-content", null, children),
    ),
    DropdownMenuItem: ({
      children,
      ...props
    }: {
      children: React.ReactNode
      [key: string]: unknown
    }) => ReactModule.createElement("button", { ...props, "data-slot": "dropdown-menu-item" }, children),
    DropdownMenuSeparator: (props: Record<string, unknown>) =>
      ReactModule.createElement("mock-dropdown-menu-separator", {
        ...props,
        "data-slot": "dropdown-menu-separator",
      }),
  }
})

vi.mock("@/components/ui/dialog", async () => {
  const ReactModule = await import("react")
  const component = (type: string, slot: string) => ({
    children,
    ...props
  }: {
    children?: React.ReactNode
    [key: string]: unknown
  }) => ReactModule.createElement(type, { ...props, "data-slot": slot }, children)
  return {
    Dialog: component("mock-dialog", "dialog"),
    DialogContent: component("mock-dialog-content", "dialog-content"),
    DialogDescription: component("mock-dialog-description", "dialog-description"),
    DialogHeader: component("mock-dialog-header", "dialog-header"),
    DialogTitle: component("mock-dialog-title", "dialog-title"),
  }
})

vi.mock("@/components/ui/tabs", async () => {
  const ReactModule = await import("react")
  return {
    Tabs: ({ children, ...props }: { children?: React.ReactNode }) =>
      ReactModule.createElement("mock-tabs", props, children),
    TabsList: ({ children, ...props }: { children?: React.ReactNode }) =>
      ReactModule.createElement("mock-tabs-list", props, children),
    TabsTrigger: ({ children, ...props }: { children?: React.ReactNode }) =>
      ReactModule.createElement("button", { ...props, "data-slot": "tabs-trigger" }, children),
  }
})

vi.mock("@/hooks/community/use-reaction-details", () => ({
  useReactionDetails: () => ({ data: { actors: [] }, isLoading: false }),
}))

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
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().activateProfileAccount("viewer")
  const profiles = useCommunityWsStore.getState()
  profiles.seedProfiles(profiles.beginProfileSnapshot(), [{
    id: "u1",
    identityAbout: { name: "Alice" },
  }])
  const g = globalThis as unknown as { ResizeObserver: unknown; IntersectionObserver: unknown }
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  g.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} }
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Message memo comparator", () => {
  it("keeps the strict Unknown fallback for unresolved live authors", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({
          authorId: "unresolved",
          authorName: "Static fixture name",
        }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    expect(textContent(renderer!.root)).toContain("Unknown")
    expect(textContent(renderer!.root)).not.toContain("Static fixture name")
  })

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

describe("Message embed links", () => {
  it("routes author and title URLs through the shared external-link anchor", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({
          embeds: [{
            title: "Example story",
            url: "https://example.com/story?from=embed",
            author: {
              name: "Example author",
              url: "https://example.com/author",
            },
          }],
        }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const links = renderer!.root.findAllByProps({ "data-message-external-link": true })
    expect(links).toHaveLength(2)
    expect(links.map((link) => link.props.href)).toEqual([
      "https://example.com/author",
      "https://example.com/story?from=embed",
    ])
    expect(links.every((link) => (
      link.props.target === "_blank" && link.props.rel === "noopener noreferrer"
    ))).toBe(true)
  })
})

describe("Message ordinary-link gesture ownership", () => {
  const secondHref = "https://example.com/second/path?from=message&mode=full#details"
  const linkAnchor = { href: secondHref, getAttribute: () => secondHref }
  const linkEventTarget = {
    closest: (selector: string) => (
      selector === "a[data-message-external-link]"
      || selector === "button, a, input, textarea, select, [role=button]"
    ) ? linkAnchor : null,
  }
  const findRow = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.find(
    (node) => typeof node.props.className === "string"
      && node.props.className.includes("group relative -mx-2"),
  )

  it("derives actual touch/mouse modality before using hover capability as fallback", () => {
    const ownedTarget = {} as EventTarget
    const portalTarget = {} as EventTarget
    const rowOwner = { contains: (target: Node | null) => target === ownedTarget }
    expect(messageEventBelongsToRow(ownedTarget, rowOwner)).toBe(true)
    expect(messageEventBelongsToRow(portalTarget, rowOwner)).toBe(false)

    expect(messageLinkPointerType({ type: "click", pointerType: "touch" })).toBe("touch")
    expect(messageLinkPointerType({
      type: "click",
      sourceCapabilities: { firesTouchEvents: true },
    })).toBe("touch")
    expect(messageLinkPointerType({ type: "click" })).toBeNull()

    expect(messageLinkClickUsesMenu({
      clickPointerType: "touch", capturedPointerType: "mouse", hoverCapable: true,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: "pen", hoverCapable: true,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: "mouse", hoverCapable: false,
    })).toBe(false)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: null, hoverCapable: false,
    })).toBe(true)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null, capturedPointerType: null, hoverCapable: true,
    })).toBe(false)
    expect(messageLinkClickUsesMenu({
      clickPointerType: null,
      capturedPointerType: null,
      hoverCapable: false,
      desktopInputSeen: true,
    })).toBe(false)
  })

  it("keeps mouse primary click direct on a touch-default device", async () => {
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    let row = findRow(renderer!)
    act(() => row.props.onPointerEnter({
      target: { closest: () => null },
      nativeEvent: { type: "pointerenter", pointerType: "mouse" },
    }))
    row = findRow(renderer!)
    expect(row.props["data-slot"]).toBe("context-menu-trigger")
    act(() => row.props.onPointerDownCapture({
      button: 0,
      target: linkEventTarget,
      nativeEvent: { type: "pointerdown", pointerType: "mouse" },
    }))
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => row.props.onClickCapture({
      clientX: 120,
      clientY: 240,
      target: linkEventTarget,
      nativeEvent: { type: "click" },
      preventDefault,
      stopPropagation,
    }))

    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(renderer!.root.findAllByProps({ "data-slot": "dropdown-menu-separator" })).toHaveLength(0)
  })

  it("keeps keyboard Enter direct on a touch-default fallback", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("window", { __TAURI__: { opener: { openUrl } } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ content: secondHref }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    const row = findRow(renderer!)
    act(() => row.props.onKeyDownCapture({
      key: "Enter",
      target: linkEventTarget,
    }))

    const anchor = renderer!.root.findAllByType("a")
      .find((node) => node.props.href === secondHref)
    expect(anchor).toBeDefined()
    const click = {
      button: 0,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      target: linkEventTarget,
      nativeEvent: { type: "click" },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    }
    await act(async () => {
      row.props.onClickCapture(click)
      anchor!.props.onClick(click)
      await Promise.resolve()
    })

    expect(click.preventDefault).toHaveBeenCalledOnce()
    expect(click.stopPropagation).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledOnce()
    expect(openUrl).toHaveBeenCalledWith(secondHref)
    expect(renderer!.root.findAllByProps({ "data-slot": "dropdown-menu-separator" })).toHaveLength(0)
  })

  it("opens the existing menu first for a real touch tap on a hover-capable hybrid", async () => {
    const openWindow = vi.fn(() => ({} as Window))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("window", { open: openWindow })
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }),
        hoverCapable: true,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onShareSingle: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    const row = findRow(renderer!)
    act(() => row.props.onPointerDownCapture({
      button: 0,
      target: linkEventTarget,
      nativeEvent: { type: "pointerdown", pointerType: "touch" },
    }))
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    await act(async () => {
      row.props.onClickCapture({
        clientX: 271,
        clientY: 603,
        target: linkEventTarget,
        nativeEvent: { type: "click" },
        preventDefault,
        stopPropagation,
      })
    })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(stopPropagation).toHaveBeenCalledOnce()
    const items = renderer!.root.findAllByProps({ "data-slot": "dropdown-menu-item" })
    const labels = items.map((item) => textContent(item).trim())
    expect(labels.slice(-3)).toEqual(["Share as Image", "Copy Link", "Open Link"])
    expect(renderer!.root.findAllByProps({ "data-slot": "dropdown-menu-separator" })).toHaveLength(1)
    const positioner = renderer!.root.find(
      (node) => node.props.positionMethod === "fixed" && node.props.anchor,
    )
    expect(positioner.props.anchor.getBoundingClientRect()).toMatchObject({
      x: 271,
      y: 603,
    })

    await act(async () => {
      items.find((item) => textContent(item).trim() === "Copy Link")?.props.onClick()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(secondHref)
    expect(openWindow).not.toHaveBeenCalled()

    await act(async () => {
      items.find((item) => textContent(item).trim() === "Open Link")?.props.onClick()
      await Promise.resolve()
    })
    expect(openWindow).toHaveBeenCalledOnce()
    expect(openWindow).toHaveBeenCalledWith(secondHref, "_blank", "noopener,noreferrer")
  })

  it("adds the link suffix only for the exact desktop secondary-click target and clears it", async () => {
    const openWindow = vi.fn()
    vi.stubGlobal("window", { open: openWindow })
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ content: `first https://example.com/first second ${secondHref}` }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onShareSingle: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    let row = findRow(renderer!)
    act(() => row.props.onPointerEnter({
      target: linkEventTarget,
      nativeEvent: { type: "pointerenter", pointerType: "mouse" },
    }))
    row = findRow(renderer!)
    act(() => row.props.onContextMenuCapture({ target: linkEventTarget }))

    let items = renderer!.root.findAllByProps({ "data-slot": "context-menu-item" })
    expect(items.map((item) => textContent(item).trim()).slice(-3)).toEqual(["Share as Image", "Copy Link", "Open Link"])
    expect(renderer!.root.findAllByProps({ "data-slot": "context-menu-separator" })).toHaveLength(1)
    expect(openWindow).not.toHaveBeenCalled()

    const contextMenu = renderer!.root.findByType("mock-context-menu")
    act(() => contextMenu.props.onOpenChange(false))
    items = renderer!.root.findAllByProps({ "data-slot": "context-menu-item" })
    expect(items.map((item) => textContent(item).trim())).not.toContain("Copy Link")
    expect(items.map((item) => textContent(item).trim())).not.toContain("Open Link")

    row = findRow(renderer!)
    act(() => row.props.onContextMenuCapture({ target: { closest: () => null } }))
    expect(renderer!.root.findAllByProps({ "data-slot": "context-menu-separator" })).toHaveLength(0)
  })
})

describe("Message portal event ownership", () => {
  it("keeps a reaction dialog mounted and ignores its pointer, click, and swipe events", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("window", { getSelection: () => null })
    vi.stubGlobal("navigator", { vibrate: vi.fn() })
    const onReply = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({
          content: "portal ownership",
          reactions: [{ emoji: "🔥", count: 1, me: false, userIds: ["u2"] }],
        }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onReply,
        onToggleReaction: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const chip = renderer!.root.findAllByType("button")
      .find((button) => textContent(button).includes("🔥") && button.props.onPointerDown)
    expect(chip).toBeDefined()
    act(() => chip!.props.onPointerDown({
      pointerType: "touch",
      clientX: 20,
      clientY: 20,
      stopPropagation: vi.fn(),
    }))
    await act(async () => {
      vi.advanceTimersByTime(451)
      await Promise.resolve()
    })
    expect(renderer!.root.findAllByType("mock-dialog-content")).toHaveLength(1)

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const portalTarget = { closest: () => null, matches: () => false }
    const rowElement = {
      contains: (target: unknown) => target !== portalTarget,
      setPointerCapture: vi.fn(),
    }
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    act(() => row.props.onPointerEnter({
      target: portalTarget,
      currentTarget: rowElement,
      nativeEvent: { type: "pointerenter", pointerType: "mouse" },
    }))
    act(() => row.props.onClickCapture({
      target: portalTarget,
      currentTarget: rowElement,
      nativeEvent: { type: "click" },
      preventDefault,
      stopPropagation,
    }))
    act(() => row.props.onClick({
      clientX: 25,
      clientY: 25,
      target: portalTarget,
      currentTarget: rowElement,
      nativeEvent: { composedPath: () => [portalTarget] },
    }))
    act(() => row.props.onPointerDown({
      pointerType: "touch",
      pointerId: 77,
      clientX: 20,
      clientY: 20,
      target: portalTarget,
      currentTarget: rowElement,
    }))
    act(() => row.props.onPointerMove({
      pointerType: "touch",
      pointerId: 77,
      clientX: 92,
      clientY: 22,
      target: portalTarget,
      currentTarget: rowElement,
      preventDefault,
    }))
    act(() => row.props.onPointerUp({
      pointerType: "touch",
      clientX: 92,
      clientY: 22,
      target: portalTarget,
      currentTarget: rowElement,
    }))

    expect(renderer!.root.findAllByType("mock-dialog-content")).toHaveLength(1)
    expect(renderer!.root.findByType("mock-dropdown-menu").props.open).toBe(false)
    expect(onReply).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })
})

describe("Message reaction picker", () => {
  it("opens the non-hover picker and suppresses its Shadow DOM selection click at the row", async () => {
    vi.stubGlobal("window", { getSelection: () => null })
    const onReact = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onReact,
      }), { createNodeMock: () => genericMock })
    })

    const addButton = renderer!.root.findAllByProps({ "aria-label": "Add reaction" })
      .find((node) => node.type === "button" && node.props.className.includes("h-6 w-7"))
    expect(addButton?.props["data-slot"]).toBe("popover-trigger")
    expect(renderer!.root.findAllByProps({ "data-slot": "popover-content" })).toHaveLength(0)

    await act(async () => {
      addButton!.props.onClick({
        button: 0,
        defaultPrevented: false,
        currentTarget: genericMock,
        target: genericMock,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })
    expect(renderer!.root.findAllByProps({ "data-slot": "popover-content" })).toHaveLength(1)

    act(() => renderer!.root.findByType(EmojiPickerPopover).props.onPick("🎉"))
    expect(onReact).toHaveBeenCalledOnce()
    expect(onReact).toHaveBeenCalledWith("🎉")

    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const rowElement = { contains: () => false }
    await act(async () => {
      row.props.onClick({
        clientX: 271,
        clientY: 603,
        currentTarget: rowElement,
        target: { closest: () => null },
        nativeEvent: {
          composedPath: () => [
            { matches: (selector: string) => selector.includes("button") },
            { matches: () => false },
            rowElement,
          ],
        },
      })
    })
    expect(renderer!.root.findAll(
      (node) => node.props.positionMethod === "fixed" && node.props.anchor,
    )).toHaveLength(0)
    expect(onReact).toHaveBeenCalledOnce()
    act(() => renderer!.unmount())
  })

  it("keeps desktop hover activation separate from click-to-open", async () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }] }),
        hoverCapable: true,
        onOpenThread: vi.fn(),
        onReact: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    expect(renderer!.root.findAllByType(EmojiPickerPopover)).toHaveLength(0)
    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    act(() => row.props.onPointerEnter({ target: { closest: () => null } }))

    expect(renderer!.root.findAllByType(EmojiPickerPopover)).toHaveLength(2)
    expect(renderer!.root.findAllByProps({ "data-slot": "popover-content" })).toHaveLength(0)
    const stripButton = renderer!.root.findAllByProps({ "aria-label": "Add reaction" })
      .find((node) => node.type === "button" && node.props.className.includes("h-6 w-7"))
    expect(stripButton?.props["data-slot"]).toBe("tooltip-trigger")

    await act(async () => {
      stripButton!.props.onClick({
        button: 0,
        defaultPrevented: false,
        currentTarget: genericMock,
        target: genericMock,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      })
    })
    expect(renderer!.root.findAllByProps({ "data-slot": "popover-content" })).toHaveLength(1)
    act(() => renderer!.unmount())
  })

  it("keeps existing reaction chips on their exact toggle callback", () => {
    const onToggleReaction = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ reactions: [{ emoji: "🔥", count: 2, me: true, userIds: ["u1", "u2"] }] }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onToggleReaction,
        onReact: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })

    const chip = renderer!.root.findAllByType("button")
      .find((button) => textContent(button).includes("🔥"))
    act(() => chip!.props.onClick())
    expect(onToggleReaction).toHaveBeenCalledOnce()
    expect(onToggleReaction).toHaveBeenCalledWith("🔥")
    act(() => renderer!.unmount())
  })

  it("keeps the touch action menu Add Reaction item as the direct thumbs-up shortcut", () => {
    const onReact = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg({ reactions: [] }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onReact,
      }), { createNodeMock: () => genericMock })
    })

    const quickReaction = renderer!.root.findAllByProps({ "data-slot": "dropdown-menu-item" })
      .find((item) => textContent(item).includes("Add Reaction"))
    expect(quickReaction).toBeDefined()
    act(() => quickReaction!.props.onClick())
    expect(onReact).toHaveBeenCalledOnce()
    expect(onReact).toHaveBeenCalledWith("👍")
    act(() => renderer!.unmount())
  })
})

describe("Message touch action menu", () => {
  it("swipes right past threshold into the existing reply callback exactly once", async () => {
    vi.stubGlobal("window", { getSelection: () => null })
    const vibrate = vi.fn()
    vi.stubGlobal("navigator", { vibrate })
    const onReply = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onReply,
      }), { createNodeMock: () => genericMock })
    })
    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const ownedTarget = { closest: () => null }
    const currentTarget = {
      contains: (target: unknown) => target === ownedTarget,
      setPointerCapture: vi.fn(),
    }
    act(() => row.props.onPointerDown({
      pointerType: "touch", clientX: 80, clientY: 100,
      target: ownedTarget, currentTarget,
    }))
    act(() => row.props.onPointerMove({
      pointerType: "touch", pointerId: 1, clientX: 148, clientY: 102,
      target: ownedTarget, currentTarget, preventDefault: vi.fn(),
    }))
    expect(renderer!.root.findByProps({ "data-mobile-reply-affordance": true }).props)
      .toMatchObject({ "data-threshold-crossed": true })
    act(() => row.props.onPointerUp({
      pointerType: "touch", target: ownedTarget, currentTarget,
    }))
    expect(onReply).toHaveBeenCalledOnce()
    expect(vibrate).toHaveBeenCalledOnce()
    expect(currentTarget.setPointerCapture).toHaveBeenCalledWith(1)
    expect(row.props.style).toBeUndefined()
  })

  it("rejects vertical movement without replying or vibrating", async () => {
    vi.stubGlobal("window", { getSelection: () => null })
    const vibrate = vi.fn()
    vi.stubGlobal("navigator", { vibrate })
    const onReply = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(), hoverCapable: false, onOpenThread: vi.fn(), onReply,
      }), { createNodeMock: () => genericMock })
    })
    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const ownedTarget = { closest: () => null }
    const currentTarget = {
      contains: (target: unknown) => target === ownedTarget,
      setPointerCapture: vi.fn(),
    }
    act(() => row.props.onPointerDown({
      pointerType: "touch", clientX: 80, clientY: 100,
      target: ownedTarget, currentTarget,
    }))
    act(() => row.props.onPointerMove({
      pointerType: "touch", pointerId: 1, clientX: 86, clientY: 130,
      target: ownedTarget, currentTarget, preventDefault: vi.fn(),
    }))
    act(() => row.props.onPointerUp({
      pointerType: "touch", target: ownedTarget, currentTarget,
    }))
    expect(onReply).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
  })

  it("cancels a pending swipe when text selection starts inside the row", async () => {
    const selectedNode = {}
    let selection: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode"> | null = null
    vi.stubGlobal("window", { getSelection: () => selection })
    const vibrate = vi.fn()
    vi.stubGlobal("navigator", { vibrate })
    const onReply = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(), hoverCapable: false, onOpenThread: vi.fn(), onReply,
      }), { createNodeMock: () => genericMock })
    })
    const row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    const ownedTarget = { closest: () => null }
    const currentTarget = {
      contains: (node: unknown) => node === ownedTarget || node === selectedNode,
      setPointerCapture: vi.fn(),
    }
    act(() => row.props.onPointerDown({
      pointerType: "touch", clientX: 80, clientY: 100,
      target: ownedTarget, currentTarget,
    }))
    selection = {
      isCollapsed: false,
      anchorNode: selectedNode as Node,
      focusNode: selectedNode as Node,
    }
    act(() => row.props.onPointerMove({
      pointerType: "touch", pointerId: 1, clientX: 150, clientY: 102,
      target: ownedTarget, currentTarget, preventDefault: vi.fn(),
    }))
    act(() => row.props.onPointerUp({
      pointerType: "touch", target: ownedTarget, currentTarget,
    }))
    expect(onReply).not.toHaveBeenCalled()
    expect(vibrate).not.toHaveBeenCalled()
    expect(currentTarget.setPointerCapture).not.toHaveBeenCalled()
    expect(renderer!.root.findByProps({ "data-mobile-reply-affordance": true }).props["data-threshold-crossed"])
      .toBeUndefined()
  })

  it("long-presses an avatar once, suppresses profile click, and cancels on movement", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("navigator", { vibrate: vi.fn() })
    const onMentionAuthor = vi.fn()
    const onOpenProfile = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(makeTree({
        m: baseMsg(),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onReply: vi.fn(),
        onMentionAuthor,
        onOpenProfile,
      }), { createNodeMock: () => genericMock })
    })
    const avatar = renderer!.root.findByProps({
      "aria-label": "Open Alice profile; long press to mention",
    })
    act(() => avatar.props.onPointerDown({ pointerType: "mouse", clientX: 30, clientY: 40 }))
    act(() => avatar.props.onPointerMove({ pointerType: "mouse", clientX: 50, clientY: 40 }))
    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 30, clientY: 40 }))
    act(() => vi.advanceTimersByTime(500))
    expect(onMentionAuthor).toHaveBeenCalledOnce()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => avatar.props.onContextMenu({ preventDefault }))
    expect(preventDefault).toHaveBeenCalledOnce()
    act(() => avatar.props.onClick({ preventDefault, stopPropagation }))
    expect(onOpenProfile).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalledTimes(2)

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 30, clientY: 40 }))
    act(() => avatar.props.onPointerMove({ pointerType: "touch", clientX: 50, clientY: 40 }))
    act(() => vi.advanceTimersByTime(500))
    expect(onMentionAuthor).toHaveBeenCalledOnce()
    act(() => avatar.props.onClick({ preventDefault, stopPropagation }))
    expect(onOpenProfile).not.toHaveBeenCalled()

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 30, clientY: 40 }))
    act(() => avatar.props.onPointerCancel({ pointerType: "touch" }))
    act(() => avatar.props.onClick({ preventDefault, stopPropagation }))
    expect(onOpenProfile).not.toHaveBeenCalled()

    act(() => avatar.props.onPointerDown({ pointerType: "touch", clientX: 30, clientY: 40 }))
    act(() => avatar.props.onPointerUp({ pointerType: "touch" }))
    act(() => avatar.props.onClick({ preventDefault, stopPropagation }))
    expect(onOpenProfile).toHaveBeenCalledOnce()
    act(() => renderer!.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

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
    const ownedTarget = { closest: () => null }
    const currentTarget = {
      contains: (target: unknown) => target === ownedTarget,
    }
    await act(async () => {
      row.props.onClick({
        clientX: 271,
        clientY: 603,
        currentTarget,
        target: ownedTarget,
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

  it("observes the desktop context target without taking over authenticated contextmenu policy", () => {
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

    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    act(() => row.props.onContextMenuCapture({
      target: { closest: () => null },
      preventDefault,
      stopPropagation,
    }))
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
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
    expect(image.props.className).toContain("size-full")
    expect(image.props.className).toContain("absolute")
    expect(image.parent?.props.className).toContain("relative")
    expect(image.parent?.props.className).toContain("max-w-full")
    expect(image.parent?.props.style).toEqual({
      width: "min(100%, 169.231px)",
      aspectRatio: "396/702",
    })
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
  it("does not swap menu shells when portal close reveals the pointer over restored focus", () => {
    const focused = {} as Element
    const row = { contains: vi.fn((target: Node | null) => target === focused) }

    expect(shouldAdoptDesktopMenuInput("mouse", row, focused)).toBe(false)
    expect(shouldAdoptDesktopMenuInput("mouse", row, null)).toBe(true)
    expect(shouldAdoptDesktopMenuInput("touch", row, null)).toBe(false)
  })

  it("keeps coarse swipe reply available after the row sees mouse input", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
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

    let row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )
    act(() => row.props.onPointerEnter({
      target: { closest: vi.fn(() => null) },
      currentTarget: genericMock,
      nativeEvent: { type: "pointerenter", pointerType: "mouse" },
    }))
    row = renderer!.root.find(
      (node) => typeof node.props.className === "string"
        && node.props.className.includes("group relative -mx-2"),
    )

    expect(row.props.onPointerDown).toBeTypeOf("function")
    expect(row.props.onPointerMove).toBeTypeOf("function")
    expect(row.props.onPointerUp).toBeTypeOf("function")
  })

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
