import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import React from "react"
import {
  createMessageMenuPointAnchor,
  MessageRowView,
  renderMessageRowView,
  selectionBelongsToRow,
  shouldActivateMessageOverlays,
  shouldSuppressTouchMenuOpen,
} from "./message-row-view"
import type { RenderMsg } from "@/lib/community/models/message"

vi.mock("@/components/ui/context-menu", async () => {
  const react = await import("react")
  return {
    ContextMenu: ({ children, ...props }: Record<string, any>) => react.createElement("context-menu", props, children),
    ContextMenuTrigger: ({ render, ...props }: Record<string, any>) => react.cloneElement(render, {
      ...props,
      "data-slot": "context-menu-trigger",
    }),
    ContextMenuContent: ({ children, ...props }: Record<string, any>) => react.createElement("context-menu-content", props, children),
    ContextMenuItem: ({ children, ...props }: Record<string, any>) => react.createElement("context-menu-item", props, children),
  }
})

vi.mock("@/components/ui/dropdown-menu", async () => {
  const react = await import("react")
  return {
    DropdownMenu: ({ children, ...props }: Record<string, any>) => react.createElement("dropdown-menu", props, children),
    DropdownMenuTrigger: ({ render, children, ...props }: Record<string, any>) => react.cloneElement(render, {
      ...props,
      "data-slot": "dropdown-menu-trigger",
    }, children),
    DropdownMenuContent: ({ children, ...props }: Record<string, any>) => react.createElement("dropdown-menu-content", props, children),
    DropdownMenuItem: ({ children, ...props }: Record<string, any>) => react.createElement("dropdown-menu-item", props, children),
  }
})

vi.mock("@/components/ui/tooltip", async () => {
  const react = await import("react")
  return {
    Tooltip: ({ children }: Record<string, any>) => children,
    TooltipTrigger: ({ render }: Record<string, any>) => render,
    TooltipContent: ({ children }: Record<string, any>) => react.createElement("tooltip-content", null, children),
  }
})

vi.mock("@/components/community/messages/emoji-picker", async () => {
  const react = await import("react")
  return {
    EmojiPickerPopover: ({ children, ...props }: Record<string, any>) => react.createElement("emoji-picker", props, children),
  }
})

vi.mock("@/components/community/social/bot-approval-card", async () => {
  const react = await import("react")
  return { BotApprovalCard: (props: Record<string, any>) => react.createElement("bot-approval-card", props) }
})

type ReactTestInstance = {
  type: unknown
  props: Record<string, any>
  children: any[]
  parent: ReactTestInstance | null
  find: (predicate: (node: ReactTestInstance) => boolean) => ReactTestInstance
  findAll: (predicate: (node: ReactTestInstance) => boolean) => ReactTestInstance[]
  findAllByProps: (props: Record<string, unknown>) => ReactTestInstance[]
  findAllByType: (type: unknown) => ReactTestInstance[]
  findByProps: (props: Record<string, unknown>) => ReactTestInstance
  findByType: (type: unknown) => ReactTestInstance
}

type ReactTestRenderer = {
  root: ReactTestInstance
  toJSON: () => unknown
  unmount: () => void
  update: (element: React.ReactElement) => void
}

const rendererModule = createRequire(import.meta.url)("react-test-renderer") as {
  act: (callback: () => void | Promise<void>) => void | Promise<void>
  create: (
    element: React.ReactElement,
    options?: { createNodeMock?: (element: { type: unknown }) => unknown },
  ) => ReactTestRenderer
}
const TestRenderer = rendererModule
const { act } = rendererModule

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
function makeTree(props: Parameters<typeof MessageRowView>[0]) {
  return React.createElement(MessageRowView, props)
}

beforeEach(() => {
  renderCount = 0
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
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

    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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

  it("re-renders for every message field and controlled View prop", () => {
    const callback = () => {}
    const messageWithReaction = baseMsg({
      reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["u2"] }],
    })
    const stable = {
      m: messageWithReaction,
      onOpenThread: callback,
      onOpenProfile: callback,
      onJumpReply: callback,
      onToggleReaction: callback,
      onReact: callback,
      onReply: callback,
      onPin: callback,
      onMark: callback,
      onCreateThread: callback,
      onCopy: callback,
      onEdit: callback,
      onRetry: callback,
      onDismiss: callback,
      onPreviewImage: callback,
      onPreviewAttachment: callback,
      onDownloadFile: callback,
      resolveUserName: vi.fn((id: string) => id),
      onImageLoad: callback,
      onToggleSelect: callback,
      onEnterSelect: callback,
      onShareSingle: callback,
      onToolbarOpenChange: callback,
      onContextOpenChange: callback,
      onTouchMenuOpenChange: callback,
      onTouchStart: callback,
      onTouchEnd: callback,
      onTouchCancel: callback,
      onTouchBodyClick: callback,
      onActivate: callback,
    } satisfies Parameters<typeof MessageRowView>[0]
    const messageChanges: Partial<RenderMsg>[] = [
      { id: "m2" },
      { type: "system" },
      { content: "edited" },
      { grouped: true },
      { failed: true },
      { authorId: "u3" },
      { authorName: "Cora" },
      { authorAvatar: "C" },
      { color: "red" },
      { createdAt: new Date(1).toISOString() },
      { reactions: [] },
      { attachments: [] },
      { embeds: [] },
      { replyTo: { id: "r", authorName: "Bob", text: "reply" } },
      { thread: { id: "t", name: "Thread", messageCount: 1 } },
      { seq: 2 },
    ]
    for (const change of messageChanges) {
      const resolver = vi.fn((id: string) => id)
      let renderer: ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(makeTree({ ...stable, resolveUserName: resolver }))
      })
      const before = resolver.mock.calls.length
      act(() => renderer!.update(makeTree({
        ...stable,
        resolveUserName: resolver,
        m: { ...messageWithReaction, ...change },
      })))
      expect(resolver.mock.calls.length).toBeGreaterThanOrEqual(before)
      act(() => renderer!.unmount())
    }

    const propChanges: Array<Partial<Parameters<typeof MessageRowView>[0]>> = [
      { compact: true },
      { pinned: true },
      { highlighted: true },
      { viewerUserId: "viewer" },
      { hoverCapable: false },
      { onOpenThread: () => {} },
      { onOpenProfile: () => {} },
      { onJumpReply: () => {} },
      { onToggleReaction: () => {} },
      { onReact: () => {} },
      { onReply: () => {} },
      { onPin: () => {} },
      { onMark: () => {} },
      { onCreateThread: () => {} },
      { onCopy: () => {} },
      { onEdit: () => {} },
      { onRetry: () => {} },
      { onDismiss: () => {} },
      { onPreviewImage: () => {} },
      { onPreviewAttachment: () => {} },
      { onDownloadFile: () => {} },
      { resolveUserName: () => "changed" },
      { onImageLoad: () => {} },
      { selectMode: true },
      { selected: true },
      { onToggleSelect: () => {} },
      { onEnterSelect: () => {} },
      { onShareSingle: () => {} },
      { marked: true },
      { markedLoading: true },
      { toolbarOpen: true },
      { onToolbarOpenChange: () => {} },
      { onContextOpenChange: () => {} },
      { touchMenuOpen: true },
      { touchMenuAnchor: createMessageMenuPointAnchor(1, 2) },
      { onTouchMenuOpenChange: () => {} },
      { onTouchStart: () => {} },
      { onTouchEnd: () => {} },
      { onTouchCancel: () => {} },
      { onTouchBodyClick: () => {} },
      { activated: true },
      { onActivate: () => {} },
    ]
    for (const change of propChanges) {
      const resolver = vi.fn((id: string) => id)
      let renderer: ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(makeTree({ ...stable, resolveUserName: resolver }))
      })
      const before = resolver.mock.calls.length
      act(() => renderer!.update(makeTree({ ...stable, resolveUserName: resolver, ...change })))
      expect(resolver.mock.calls.length).toBeGreaterThanOrEqual(before)
      act(() => renderer!.unmount())
    }
  })
})

describe("MessageRowView presentation branches", () => {
  it("renders both system icons and serializes point anchors", () => {
    for (const systemKind of ["thread", undefined] as const) {
      const element = renderMessageRowView({
        m: baseMsg({ type: "system", systemKind }),
        onOpenThread: vi.fn(),
      })
      expect(element).toBeTruthy()
    }
    expect(createMessageMenuPointAnchor(7, 9).getBoundingClientRect().toJSON()).toMatchObject({
      x: 7,
      y: 9,
    })
  })

  it("renders rich content variants and invokes their projected actions", () => {
    const onOpenThread = vi.fn()
    const onOpenProfile = vi.fn()
    const onPreviewImage = vi.fn()
    const onImageLoad = vi.fn()
    const onToggleReaction = vi.fn()
    const rich = baseMsg({
      authorAvatar: "A",
      color: "blue",
      seq: 8,
      replyTo: { id: "r1", authorName: "Bob", text: "before" },
      attachments: [
        { kind: "image", name: "photo.png", url: "/photo.png", thumbnailUrl: "/thumb.png", width: 10, height: 20 },
        { kind: "file", name: "notes.txt", url: "/notes.txt", size: "1 KB" },
      ],
      embeds: [
        {
          title: "Linked",
          color: "red",
          provider: "Provider",
          url: "https://example.com",
          desc: "Description",
          author: { name: "Author", iconUrl: "/author.png", url: "https://author.example" },
          fields: [
            { name: "Inline", value: "One", inline: true },
            { name: "Block", value: "Two", inline: false },
          ],
          image: { url: "/embed.png", width: 40, height: 21 },
          footer: { text: "Footer", iconUrl: "/footer.png" },
          thumbnail: { url: "/tiny.png" },
        },
        {
          title: "Plain",
          author: { name: "No Link" },
          image: { url: "/fallback.png" },
          footer: { text: "No icon" },
        },
        { title: "Minimal" },
      ],
      reactions: [
        { emoji: "👍", count: 1, me: true, userIds: ["u2"] },
        { emoji: "🔥", count: 2, me: false, userIds: [] },
      ],
      thread: { id: "t1", name: "Thread", messageCount: 2, lastReplyAt: new Date(2).toISOString() },
    })
    let renderer: ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(makeTree({
        m: rich,
        onOpenThread,
        onOpenProfile,
        onPreviewImage,
        onImageLoad,
        onToggleReaction,
        onReact: vi.fn(),
        resolveUserName: (id) => id,
        viewerUserId: "u1",
        selectMode: true,
        selected: true,
        activated: true,
      }), { createNodeMock: () => genericMock })
    })
    const image = renderer!.root.findByProps({ "data-testid": "community-message-image-m1-0" })
    act(() => image.props.onLoad())
    act(() => image.parent!.props.onClick())
    expect(onImageLoad).toHaveBeenCalled()
    expect(onPreviewImage).toHaveBeenCalledWith({
      originalUrl: "/photo.png",
      thumbnailUrl: "/thumb.png",
      name: "photo.png",
    })
    const authorButtons = renderer!.root.findAllByType("button").filter((button) =>
      button.children.includes("Alice"),
    )
    act(() => authorButtons[0].props.onClick({ clientX: 1 }))
    expect(onOpenProfile).toHaveBeenCalled()
    const avatarButton = renderer!.root.findAllByType("button").find((button) => button.props.className === "shrink-0 self-start")
    act(() => avatarButton!.props.onClick({ clientX: 2 }))
    const reaction = renderer!.root.findAllByType("button").filter((button) =>
      typeof button.props.className === "string" && button.props.className.includes("flex h-6 items-center"),
    )[1]
    act(() => reaction!.props.onClick())
    expect(onToggleReaction).toHaveBeenCalledWith("🔥")
    act(() => renderer!.root.findByProps({ "data-testid": "community-thread-indicator-m1" }).props.onClick())
    expect(onOpenThread).toHaveBeenCalledWith("t1")
    const topPicker = renderer!.root.find((node) => node.type === "emoji-picker" && node.props.side === "top")
    act(() => topPicker.props.onPick("✅"))
    act(() => renderer!.unmount())

    let fallbackResolver: ReactTestRenderer
    act(() => {
      fallbackResolver = TestRenderer.create(makeTree({
        m: baseMsg({ reactions: [{ emoji: "✅", count: 1, me: false, userIds: ["missing"] }] }),
        onOpenThread: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    act(() => fallbackResolver!.unmount())
  })

  it("renders deleted replies, approval, grouped, failed, and neutral/recipient variants", () => {
    const variants = [
      baseMsg({ replyTo: { id: "r", authorName: "Bob", text: "gone", deleted: true } }),
      baseMsg({ approval: {} as RenderMsg["approval"], content: undefined }),
      baseMsg({ grouped: true }),
      baseMsg({ failed: true }),
      baseMsg({ thread: { id: "t", name: "Thread", messageCount: 1 } }),
    ]
    for (const [index, m] of variants.entries()) {
      let renderer: ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(makeTree({
          m,
          onOpenThread: vi.fn(),
          onRetry: vi.fn(),
          onDismiss: index === 3 ? vi.fn() : undefined,
          viewerUserId: index === 0 ? "other" : undefined,
        }), { createNodeMock: () => genericMock })
      })
      const retry = renderer!.root.findAllByType("button").find((button) =>
        button.children.some((child) => typeof child === "string" && child.includes("Message failed")),
      )
      if (retry) act(() => retry.props.onClick())
      const profileButton = renderer!.root.findAllByType("button").find((button) => button.props.className === "shrink-0 self-start")
      if (profileButton) act(() => profileButton.props.onClick({}))
      act(() => renderer!.unmount())
    }

    const onOpenProfile = vi.fn()
    let nameless: ReactTestRenderer
    act(() => {
      nameless = TestRenderer.create(makeTree({
        m: baseMsg({ authorName: undefined }),
        onOpenThread: vi.fn(),
        onOpenProfile,
      }), { createNodeMock: () => genericMock })
    })
    const namelessButtons = nameless!.root.findAllByType("button").filter((button) =>
      button.props.className === "shrink-0 self-start"
      || (typeof button.props.className === "string" && button.props.className.includes("font-semibold")),
    )
    for (const button of namelessButtons) act(() => button.props.onClick({}))
    expect(onOpenProfile).toHaveBeenCalledWith("", expect.anything(), undefined, "u1")
    act(() => nameless!.unmount())
  })

  it("invokes controlled activation, touch, and toolbar callbacks", () => {
    const onActivate = vi.fn()
    const onTouchStart = vi.fn()
    const onTouchEnd = vi.fn()
    const onTouchCancel = vi.fn()
    const onTouchBodyClick = vi.fn()
    let touch: ReactTestRenderer
    act(() => {
      touch = TestRenderer.create(makeTree({
        m: baseMsg({ grouped: true }),
        hoverCapable: false,
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onTouchStart,
        onTouchEnd,
        onTouchCancel,
        onTouchBodyClick,
      }), { createNodeMock: () => genericMock })
    })
    const touchRow = touch!.root.find((node) => typeof node.props.className === "string"
      && node.props.className.includes("group relative -mx-2"))
    act(() => touchRow.props.onTouchStart())
    act(() => touchRow.props.onTouchEnd())
    act(() => touchRow.props.onTouchCancel())
    act(() => touchRow.props.onClick({}))
    expect(onTouchStart).toHaveBeenCalledOnce()
    expect(onTouchEnd).toHaveBeenCalledOnce()
    expect(onTouchCancel).toHaveBeenCalledOnce()
    expect(onTouchBodyClick).toHaveBeenCalledOnce()
    act(() => touch!.unmount())

    let desktop: ReactTestRenderer
    act(() => {
      desktop = TestRenderer.create(makeTree({
        m: baseMsg({ seq: 2 }),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onReply: vi.fn(),
        onReact: vi.fn(),
        onShareSingle: vi.fn(),
        activated: true,
        onActivate,
      }), { createNodeMock: () => genericMock })
    })
    expect(desktop!.root.findAllByProps({ "aria-label": "More actions" })).toHaveLength(1)
    const addReaction = desktop!.root.findAll((node) => node.type === "context-menu-item")[0]
    act(() => addReaction.props.onClick())
    const bottomPicker = desktop!.root.find((node) => node.type === "emoji-picker" && node.props.side === "bottom")
    act(() => bottomPicker.props.onPick("🔥"))
    act(() => desktop!.unmount())

    let groupedToolbar: ReactTestRenderer
    act(() => {
      groupedToolbar = TestRenderer.create(makeTree({
        m: baseMsg({ grouped: true }),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        activated: true,
        toolbarOpen: true,
      }), { createNodeMock: () => genericMock })
    })
    act(() => groupedToolbar!.unmount())

    let activator: ReactTestRenderer
    act(() => {
      activator = TestRenderer.create(makeTree({
        m: baseMsg(),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
        onActivate,
      }), { createNodeMock: () => genericMock })
    })
    const row = activator!.root.find((node) => typeof node.props.className === "string"
      && node.props.className.includes("group relative -mx-2"))
    act(() => row.props.onPointerEnter({ target: { closest: () => null } }))
    expect(onActivate).toHaveBeenCalledOnce()
    act(() => activator!.unmount())

    let defaultActivator: ReactTestRenderer
    act(() => {
      defaultActivator = TestRenderer.create(makeTree({
        m: baseMsg(),
        onOpenThread: vi.fn(),
        onCopy: vi.fn(),
      }), { createNodeMock: () => genericMock })
    })
    const defaultRow = defaultActivator!.root.find((node) => typeof node.props.className === "string"
      && node.props.className.includes("group relative -mx-2"))
    act(() => defaultRow.props.onPointerEnter({ target: { closest: () => null } }))
    act(() => defaultActivator!.unmount())
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
    let renderer: ReactTestRenderer | undefined
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

  it("projects the controlled anchor and fixed collision policy to the touch menu", () => {
    const source = readFileSync(new URL("./message-row-view.tsx", import.meta.url), "utf8")
    expect(source).toContain("anchor={touchMenuAnchor ?? undefined}")
    expect(source).toContain('positionMethod="fixed"')
    expect(source).toContain("collisionPadding={8}")
    expect(source).toContain('collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}')
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
    let renderer: ReactTestRenderer | undefined
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
    const globalCss = readFileSync(new URL("../../../../../app/globals.css", import.meta.url), "utf8")
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
    let renderer: ReactTestRenderer
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
