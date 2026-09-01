import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

vi.mock("@/hooks/community/use-reaction-details", () => ({
  useReactionDetails: () => ({
    data: {
      messageId: "message_1",
      scope: { kind: "server", serverId: "server_1", channelId: "channel_1" },
      actors: [
        { userId: "user_1", profile: { id: "user_1", name: "Alice", discriminator: "0001", avatar: "A", avatarVersion: 0 } },
        { userId: "user_2", profile: { id: "user_2", name: "Bob", discriminator: "0002", avatar: "B", avatarVersion: 0 } },
      ],
    },
    isLoading: false,
  }),
}))
vi.mock("@/stores/community/ws", () => ({
  useCommunityProfile: () => undefined,
}))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children, ...props }: { open: boolean; children: React.ReactNode }) =>
    React.createElement("mock-dialog", { "data-open": open, ...props }, open ? children : null),
  DialogContent: ({ children, ...props }: React.ComponentProps<"div">) =>
    React.createElement("mock-dialog-content", props, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTitle: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("mock-dialog-title", props, children),
  DialogDescription: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("mock-dialog-description", props, children),
}))
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, value }: { children: React.ReactNode; value: string }) =>
    React.createElement("mock-tabs", { value }, children),
  TabsList: ({ children, variant: _variant, ...props }: { children: React.ReactNode; variant?: string }) =>
    React.createElement("div", props, children),
  TabsTrigger: ({ children, ...props }: React.ComponentProps<"button">) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}))

import {
  MessageReactions,
  reconcileReactionSelection,
  resolveReactionFinalFocus,
  restoreReactionFocus,
} from "./message-reactions"
import { tid } from "@/lib/community/testids"

const buttonNode = {
  focus: vi.fn(),
  isConnected: true,
  getBoundingClientRect: () => ({ left: 0, right: 52 }),
}
const reactionGroupNode = { focus: vi.fn() }
const reactionScrollerNode = {
  scrollLeft: 0,
  scrollWidth: 180,
  clientWidth: 120,
  getBoundingClientRect: () => ({ left: 0, right: 120 }),
}
const reactions = [
  { emoji: "👍", count: 1, me: false, userIds: ["user_1"] },
  { emoji: "🔥", count: 1, me: true, userIds: ["user_2"] },
]

function renderReactions(
  onToggleReaction = vi.fn(),
  reactionItems = reactions,
) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(MessageReactions, {
        messageId: "message_1",
        authorName: "Alice",
        messagePreview: "A deliberately long message preview",
        reactions: reactionItems,
        hoverCapable: false,
        tooltipActive: false,
        onToggleReaction,
      }),
      {
        createNodeMock: (node) => node.props?.["data-testid"] === tid.reactionScroller("message_1")
          ? reactionScrollerNode
          : node.type === "button"
          ? buttonNode
          : node.props?.["data-testid"] === tid.reactionGroup("message_1")
            ? reactionGroupNode
            : {},
      },
    )
  })
  return { renderer: renderer!, onToggleReaction }
}

describe("MessageReactions", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    buttonNode.isConnected = true
  })

  it("keeps a normal chip click as the exact toggle action", () => {
    const { renderer, onToggleReaction } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }))
    expect(onToggleReaction).toHaveBeenCalledWith("👍")
  })

  it("opens details after a stationary hold without firing the trailing click", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "🔥") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(449))
    expect(renderer.root.findByType("mock-dialog").props["data-open"]).toBe(false)
    act(() => vi.advanceTimersByTime(1))
    expect(renderer.root.findByType("mock-dialog").props["data-open"]).toBe(true)
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    act(() => chip.props.onClick(event))
    expect(onToggleReaction).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it("cancels both the hold and trailing toggle when the finger scrolls", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => chip.props.onPointerMove({ pointerType: "touch", clientX: 10, clientY: 25, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(500))
    expect(renderer.root.findByType("mock-dialog").props["data-open"]).toBe(false)
    act(() => chip.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() }))
    expect(onToggleReaction).not.toHaveBeenCalled()
  })

  it("requests a 44px mobile close target for the details dialog", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    expect(renderer.root.findByType("mock-dialog-content").props.className)
      .toContain("**:data-[slot=dialog-close]:size-11")
  })

  it("constrains long reactor lists to the dialog scroll region", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    expect(renderer.root.findByType("mock-dialog-content").props.className)
      .toContain("flex-col")
    expect(renderer.root.findByProps({ role: "tabpanel" }).props.className)
      .toContain("flex-auto")
  })

  it("switches the dialog surface with its overflow fades without a color transition", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    expect(renderer.root.findByType("mock-dialog-content").props.className)
      .toContain("transition-none")
    expect(renderer.root.findByType("mock-dialog-content").props.className)
      .toContain("**:data-[slot=dialog-close]:transition-none")
  })

  it("renders a transparent single-line horizontal tab rail with an accessible label", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const rail = renderer.root.findByProps({ "data-testid": tid.reactionScroller("message_1") })
    expect(rail.props["aria-label"]).toBe("Reaction types")
    expect(rail.props.className).toContain("flex-nowrap")
    expect(rail.props.className).toContain("overflow-x-auto")
    expect(rail.props.className).toContain("bg-transparent!")
  })

  it("fills only the active reaction tab without relying on the line indicator", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const tab = renderer.root.findByProps({ "data-testid": tid.reactionTab("👍") })
    expect(tab.props.className).toContain("data-active:bg-accent!")
    expect(tab.props.className).toContain("data-active:text-foreground!")
    expect(tab.props.className).toContain("after:hidden")
  })

  it("uses the message author and one-line message preview as its header", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const title = renderer.root.findByType("mock-dialog-title")
    const description = renderer.root.findByType("mock-dialog-description")
    expect(title.children).toEqual(["Alice"])
    expect(title.props.className).toContain("truncate")
    expect(description.children).toEqual(["A deliberately long message preview"])
    expect(description.props.className).toContain("truncate")
  })

  it("uses the shared 32px identity row for authorized reactors", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const member = renderer.root.findByProps({ "data-testid": tid.reactionMember("user_1") })
    const text = member.findAll((node) => node.children.some((child) => typeof child === "string"))
      .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
      .join("")
    expect(text).toContain("Alice")
    expect(text).toContain("#0001")
  })

  it("keeps an unauthorized actor on the Unknown member fallback", () => {
    vi.useFakeTimers()
    const unknownReactions = [{ emoji: "👀", count: 1, me: false, userIds: ["user_3"] }]
    const { renderer } = renderReactions(vi.fn(), unknownReactions)
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👀") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const member = renderer.root.findByProps({ "data-testid": tid.reactionMember("user_3") })
    const text = member.findAll((node) => node.children.some((child) => typeof child === "string"))
      .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
      .join("")
    expect(text).toContain("Unknown member")
    expect(text).not.toContain("#000")
  })

  it("restores the connected initiating chip after the dialog finishes closing", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const content = renderer.root.findByType("mock-dialog-content")
    expect(content.props.finalFocus).toBe(false)
    const dialog = renderer.root.findByType("mock-dialog")
    act(() => dialog.props.onOpenChange(false))
    expect(buttonNode.focus).not.toHaveBeenCalled()
    act(() => dialog.props.onOpenChangeComplete(false))
    expect(buttonNode.focus).toHaveBeenCalledOnce()
    expect(buttonNode.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it("restores the reaction group itself when the initiating chip disappeared", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    act(() => renderer.update(React.createElement(MessageReactions, {
      messageId: "message_1",
      authorName: "Alice",
      messagePreview: "A deliberately long message preview",
      reactions: [],
      hoverCapable: false,
      tooltipActive: false,
      onToggleReaction,
    })))
    buttonNode.isConnected = false
    const dialog = renderer.root.findByType("mock-dialog")
    act(() => dialog.props.onOpenChangeComplete(false))
    expect(reactionGroupNode.focus).toHaveBeenCalledOnce()
    expect(reactionGroupNode.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})

describe("reconcileReactionSelection", () => {
  it("keeps the selected emoji while it remains live", () => {
    expect(reconcileReactionSelection(["👍", "🔥"], ["👍", "🔥", "🎉"], "🔥")).toBe("🔥")
  })

  it("selects the stable neighboring tab when the selected emoji disappears", () => {
    expect(reconcileReactionSelection(["👍", "🔥", "🎉"], ["👍", "🎉"], "🔥")).toBe("🎉")
    expect(reconcileReactionSelection(["👍", "🔥"], ["👍"], "🔥")).toBe("👍")
  })

  it("closes selection when the final reaction disappears", () => {
    expect(reconcileReactionSelection(["👍"], [], "👍")).toBeNull()
  })
})

describe("resolveReactionFinalFocus", () => {
  it("resolves the connected initiating chip, then the stable reaction group", () => {
    const connectedChip = { isConnected: true } as HTMLButtonElement
    const disconnectedChip = { isConnected: false } as HTMLButtonElement
    const group = {} as HTMLDivElement

    expect(resolveReactionFinalFocus(connectedChip, group)).toBe(connectedChip)
    expect(resolveReactionFinalFocus(disconnectedChip, group)).toBe(group)
    expect(resolveReactionFinalFocus(null, group)).toBe(group)
  })
})

describe("restoreReactionFocus", () => {
  it("focuses the exact resolved element without choosing a tabbable child", () => {
    const focus = vi.fn()
    const group = { focus } as unknown as HTMLDivElement

    expect(restoreReactionFocus(null, group)).toBe(group)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
