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
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
}))
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, value }: { children: React.ReactNode; value: string }) =>
    React.createElement("mock-tabs", { value }, children),
  TabsList: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  TabsTrigger: ({ children, ...props }: React.ComponentProps<"button">) =>
    React.createElement("button", props, children),
}))
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement("span", null, children),
}))

import { MessageReactions, reconcileReactionSelection } from "./message-reactions"
import { tid } from "@/lib/community/testids"

const buttonNode = { focus: vi.fn(), isConnected: true }
const reactionGroupNode = { focus: vi.fn() }
const reactions = [
  { emoji: "👍", count: 1, me: false, userIds: ["user_1"] },
  { emoji: "🔥", count: 1, me: true, userIds: ["user_2"] },
]

function renderReactions(onToggleReaction = vi.fn()) {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(MessageReactions, {
        messageId: "message_1",
        reactions,
        hoverCapable: false,
        tooltipActive: false,
        onToggleReaction,
      }),
      {
        createNodeMock: (node) => node.type === "button"
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

  it("restores focus after the dialog close focus handoff", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    const dialog = renderer.root.findByType("mock-dialog")
    act(() => dialog.props.onOpenChange(false))
    expect(buttonNode.focus).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(0))
    expect(buttonNode.focus).toHaveBeenCalledOnce()
  })

  it("restores focus to the reaction group when the initiating chip disappeared", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = renderer.root.findByProps({ "data-testid": tid.reactionChip("message_1", "👍") })
    act(() => chip.props.onPointerDown({ pointerType: "touch", clientX: 10, clientY: 10, stopPropagation: vi.fn() }))
    act(() => vi.advanceTimersByTime(450))
    act(() => renderer.update(React.createElement(MessageReactions, {
      messageId: "message_1",
      reactions: [],
      hoverCapable: false,
      tooltipActive: false,
      onToggleReaction,
    })))
    buttonNode.isConnected = false
    const dialog = renderer.root.findByType("mock-dialog")
    act(() => dialog.props.onOpenChange(false))
    act(() => vi.advanceTimersByTime(0))
    expect(buttonNode.focus).not.toHaveBeenCalled()
    expect(reactionGroupNode.focus).toHaveBeenCalledOnce()
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
