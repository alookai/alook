import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, fireEvent, render, type RenderResult } from "@/test/react-dom-harness"

const dialogMocks = vi.hoisted(() => ({ props: vi.fn() }))

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
  Dialog: ({ open, children, ...props }: { open: boolean; children: React.ReactNode }) => {
    dialogMocks.props({ open, ...props })
    return React.createElement("div", {
      "data-mock-dialog": "",
      "data-open": String(open),
    }, open ? children : null)
  },
  DialogContent: ({ children, finalFocus, ...props }: React.ComponentProps<"div"> & {
    finalFocus?: boolean
  }) => React.createElement("div", {
    ...props,
    "data-mock-dialog-content": "",
    "data-final-focus": String(finalFocus),
  }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
  DialogTitle: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("h2", props, children),
  DialogDescription: ({ children, ...props }: { children: React.ReactNode }) => React.createElement("p", props, children),
}))
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, value }: { children: React.ReactNode; value: string }) =>
    React.createElement("div", { "data-mock-tabs": "", "data-value": value }, children),
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

const reactions = [
  { emoji: "👍", count: 1, me: false, userIds: ["user_1"] },
  { emoji: "🔥", count: 1, me: true, userIds: ["user_2"] },
]

function renderReactions(
  onToggleReaction = vi.fn(),
  reactionItems = reactions,
) {
  const renderer = render(React.createElement(MessageReactions, {
    messageId: "message_1",
    authorName: "Alice",
    messagePreview: "A deliberately long message preview",
    reactions: reactionItems,
    hoverCapable: false,
    tooltipActive: false,
    onToggleReaction,
  }))
  return { renderer, onToggleReaction }
}

function byTestId(renderer: RenderResult, testId: string) {
  const element = renderer.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!element) throw new Error(`Expected test id ${testId}`)
  return element
}

function reactionChip(renderer: RenderResult, emoji: string) {
  return byTestId(renderer, tid.reactionChip("message_1", emoji)) as HTMLButtonElement
}

function openDetails(renderer: RenderResult, emoji: string) {
  fireEvent.pointerDown(reactionChip(renderer, emoji), {
    pointerType: "touch",
    clientX: 10,
    clientY: 10,
  })
  act(() => vi.advanceTimersByTime(450))
}

function currentDialogProps() {
  return dialogMocks.props.mock.calls.at(-1)?.[0] as {
    onOpenChange: (open: boolean) => void
    onOpenChangeComplete: (open: boolean) => void
  }
}

describe("MessageReactions", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("keeps a normal chip click as the exact toggle action", () => {
    const { renderer, onToggleReaction } = renderReactions()
    fireEvent.click(reactionChip(renderer, "👍"))
    expect(onToggleReaction).toHaveBeenCalledWith("👍")
  })

  it("opens details after a stationary hold without firing the trailing click", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = reactionChip(renderer, "🔥")
    fireEvent.pointerDown(chip, { pointerType: "touch", clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(449))
    expect(renderer.container.querySelector("[data-mock-dialog]")?.getAttribute("data-open"))
      .toBe("false")
    act(() => vi.advanceTimersByTime(1))
    expect(renderer.container.querySelector("[data-mock-dialog]")?.getAttribute("data-open"))
      .toBe("true")
    fireEvent.click(chip)
    expect(onToggleReaction).not.toHaveBeenCalled()
  })

  it("cancels both the hold and trailing toggle when the finger scrolls", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = reactionChip(renderer, "👍")
    fireEvent.pointerDown(chip, { pointerType: "touch", clientX: 10, clientY: 10 })
    fireEvent.pointerMove(chip, { pointerType: "touch", clientX: 10, clientY: 25 })
    act(() => vi.advanceTimersByTime(500))
    expect(renderer.container.querySelector("[data-mock-dialog]")?.getAttribute("data-open"))
      .toBe("false")
    fireEvent.click(chip)
    expect(onToggleReaction).not.toHaveBeenCalled()
  })

  it("requests a 44px mobile close target for the details dialog", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    expect(renderer.container.querySelector("[data-mock-dialog-content]")?.className)
      .toContain("**:data-[slot=dialog-close]:size-11")
  })

  it("constrains long reactor lists to the dialog scroll region", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    expect(renderer.container.querySelector("[data-mock-dialog-content]")?.className)
      .toContain("flex-col")
    expect(renderer.container.querySelector('[role="tabpanel"]')?.className)
      .toContain("flex-auto")
  })

  it("switches the dialog surface with its overflow fades without a color transition", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    expect(renderer.container.querySelector("[data-mock-dialog-content]")?.className)
      .toContain("transition-none")
    expect(renderer.container.querySelector("[data-mock-dialog-content]")?.className)
      .toContain("**:data-[slot=dialog-close]:transition-none")
  })

  it("renders a transparent single-line horizontal tab rail with an accessible label", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    const rail = byTestId(renderer, tid.reactionScroller("message_1"))
    expect(rail.getAttribute("aria-label")).toBe("Reaction types")
    expect(rail.className).toContain("flex-nowrap")
    expect(rail.className).toContain("overflow-x-auto")
    expect(rail.className).toContain("bg-transparent!")
  })

  it("fills only the active reaction tab without relying on the line indicator", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    const tab = byTestId(renderer, tid.reactionTab("👍"))
    expect(tab.className).toContain("data-active:bg-accent!")
    expect(tab.className).toContain("data-active:text-foreground!")
    expect(tab.className).toContain("after:hidden")
  })

  it("uses the message author and one-line message preview as its header", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    const title = renderer.container.querySelector("h2")!
    const description = renderer.container.querySelector("p")!
    expect(title.textContent).toBe("Alice")
    expect(title.className).toContain("truncate")
    expect(description.textContent).toBe("A deliberately long message preview")
    expect(description.className).toContain("truncate")
  })

  it("uses the shared 32px identity row for authorized reactors", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    openDetails(renderer, "👍")
    const text = byTestId(renderer, tid.reactionMember("user_1")).textContent
    expect(text).toContain("Alice")
    expect(text).toContain("#0001")
  })

  it("keeps an unauthorized actor on the Unknown member fallback", () => {
    vi.useFakeTimers()
    const unknownReactions = [{ emoji: "👀", count: 1, me: false, userIds: ["user_3"] }]
    const { renderer } = renderReactions(vi.fn(), unknownReactions)
    openDetails(renderer, "👀")
    const text = byTestId(renderer, tid.reactionMember("user_3")).textContent
    expect(text).toContain("Unknown member")
    expect(text).not.toContain("#000")
  })

  it("restores the connected initiating chip after the dialog finishes closing", () => {
    vi.useFakeTimers()
    const { renderer } = renderReactions()
    const chip = reactionChip(renderer, "👍")
    const focus = vi.spyOn(chip, "focus")
    fireEvent.pointerDown(chip, { pointerType: "touch", clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(450))
    expect(renderer.container.querySelector("[data-mock-dialog-content]")
      ?.getAttribute("data-final-focus")).toBe("false")
    act(() => currentDialogProps().onOpenChange(false))
    expect(focus).not.toHaveBeenCalled()
    act(() => currentDialogProps().onOpenChangeComplete(false))
    expect(focus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it("restores the reaction group itself when the initiating chip disappeared", () => {
    vi.useFakeTimers()
    const { renderer, onToggleReaction } = renderReactions()
    const chip = reactionChip(renderer, "👍")
    const group = byTestId(renderer, tid.reactionGroup("message_1"))
    const focus = vi.spyOn(group, "focus")
    fireEvent.pointerDown(chip, { pointerType: "touch", clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(450))
    renderer.rerender(React.createElement(MessageReactions, {
      messageId: "message_1",
      authorName: "Alice",
      messagePreview: "A deliberately long message preview",
      reactions: [],
      hoverCapable: false,
      tooltipActive: false,
      onToggleReaction,
    }))
    expect(chip.isConnected).toBe(false)
    act(() => currentDialogProps().onOpenChangeComplete(false))
    expect(focus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
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
