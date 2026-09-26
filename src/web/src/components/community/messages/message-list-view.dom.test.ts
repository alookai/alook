import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test/react-dom-harness"
import { renderMessageListView } from "./message-list-view"
import { ComposerAccessoryRail } from "./composer-accessory-rail"
import { MessageShareDialog } from "./message-share-dialog"
import type { MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

vi.mock("./composer-accessory-rail", () => ({
  ComposerAccessoryRail: vi.fn((props: Record<string, unknown>) => React.createElement("accessory-rail", props)),
  MessageSelectionFooter: ({
    selectedCount,
    onCancel,
    onShare,
  }: {
    selectedCount: number
    onCancel: () => void
    onShare: () => void
  }) => React.createElement("div", { "data-selection": "active" },
    React.createElement("button", {
      "aria-label": "Cancel message selection",
      onClick: onCancel,
    }),
    React.createElement("button", {
      "aria-label": `Share ${selectedCount} selected messages as image`,
      onClick: onShare,
    })),
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: vi.fn(() => null) }))
vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("ticker", { value }),
}))
vi.mock("./initial-position-aurora.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

const mockedRail = vi.mocked(ComposerAccessoryRail)
const mockedShareDialog = vi.mocked(MessageShareDialog)

function initialPosition(
  overrides: Partial<MessageListController["initialPosition"]> = {},
): MessageListController["initialPosition"] {
  return {
    phase: "revealed",
    showSkeleton: false,
    contentVisible: true,
    contentInteractive: true,
    auroraVisible: false,
    ...overrides,
  }
}

function props(overrides: Partial<ResolvedMessageListProps> = {}): ResolvedMessageListProps {
  return {
    channel: "general",
    messages: [{
      id: "m1",
      type: "chat",
      authorName: "Alice",
      content: "hi",
      createdAt: new Date(0).toISOString(),
    }],
    loading: true,
    onOpenThread: vi.fn(),
    variant: "channel",
    initialScrollReady: true,
    ...overrides,
  }
}

function controller(overrides: Partial<MessageListController> = {}): MessageListController {
  return {
    items: [{ kind: "message", key: "m1", m: props().messages[0] }],
    isLoading: false,
    initialPosition: initialPosition(),
    jumped: null,
    selectMode: false,
    selectedIds: new Set(),
    selectedMessages: [],
    shareOpen: false,
    setShareOpen: vi.fn(),
    exitSelect: vi.fn(),
    closeShare: vi.fn(),
    onEnterSelectId: vi.fn(),
    onToggleSelectId: vi.fn(),
    heroRef: { current: null },
    scrollRef: { current: null },
    virtualizer: {} as MessageListController["virtualizer"],
    topSentinelRef: { current: null },
    bottomSentinelRef: { current: null },
    onImageLoad: vi.fn(),
    jumpTo: vi.fn(),
    pillCount: 3,
    pillMode: "jump",
    pillOnClick: vi.fn(),
    ...overrides,
  } as MessageListController
}

describe("renderMessageListView", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps warm non-empty loading data on the loaded DOM with the away pill", () => {
    const listProps = props()
    const state = controller()
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(listProps, state, renderRows))
    expect(mockedRail).toHaveBeenCalledWith(expect.objectContaining({
      scrollCount: 3,
    }), undefined)
    expect(mockedRail.mock.calls.at(-1)?.[0]).not.toHaveProperty("composerOverlap")
    const scrollerBoundary = renderer.container.querySelector("[data-message-scroller-boundary]")!
    expect(scrollerBoundary.querySelectorAll("accessory-rail")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelectorAll("virtual-rows")).toHaveLength(1)
    expect(renderer.container.querySelectorAll(".mb-6")).toHaveLength(1)
  })

  it("keeps the same wrappers while true empty loading omits the interactive accessory rail", () => {
    const listProps = props({ messages: [] })
    const state = controller({
      isLoading: true,
      initialPosition: initialPosition({
        phase: "skeleton",
        showSkeleton: true,
        contentVisible: false,
        contentInteractive: false,
      }),
      pillCount: 8,
    })
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(listProps, state, renderRows))
    expect(renderer.container.firstElementChild).toHaveClass(
      "relative", "flex", "min-h-0", "flex-1", "flex-col",
    )
    expect(mockedRail).not.toHaveBeenCalled()
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll(".mb-6")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(content).toHaveClass("opacity-100")
    expect(content).not.toHaveClass("transition-opacity", "duration-300")
  })

  it("keeps positioned rows measurable but inert and hidden until reveal starts", () => {
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(
      props({ loading: false }),
      controller({
        initialPosition: initialPosition({
          phase: "positioning",
          contentVisible: false,
          contentInteractive: false,
        }),
      }),
      renderRows,
    ))
    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelector("virtual-rows")).toBeInTheDocument()
    expect(content).toHaveAttribute("data-initial-position-phase", "positioning")
    expect(content).toHaveAttribute("aria-hidden", "true")
    expect(content).toHaveAttribute("inert")
    expect(content).toHaveClass("pointer-events-none", "opacity-0")
    expect(content).not.toHaveClass("transition-opacity", "duration-300")
    expect(mockedRail).not.toHaveBeenCalled()
    const skeleton = renderer.container.querySelector("[data-message-positioning-skeleton]")!
    expect(skeleton).toHaveClass(
      "absolute", "inset-0", "z-20", "pointer-events-none", "opacity-100",
    )
    expect(skeleton.querySelector('[data-slot="skeleton"]')).toBeInTheDocument()
  })

  it("keeps the typed positioning skeleton through a timeout until settlement", () => {
    const renderer = render(renderMessageListView(
      props({ loading: false }),
      controller({
        initialPosition: initialPosition({
          phase: "aurora",
          contentVisible: false,
          contentInteractive: false,
          auroraVisible: true,
        }),
      }),
      () => React.createElement("virtual-rows"),
    ))
    const content = () => renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(content()).toHaveClass("opacity-0")
    expect(content()).not.toHaveClass("transition-opacity", "duration-300")
    expect(renderer.container.querySelector("[data-message-positioning-skeleton]")).toHaveClass("opacity-100")
    expect(renderer.getByTestId("community-initial-position-aurora"))
      .toHaveAttribute("data-phase", "aurora")

    renderer.rerender(renderMessageListView(
      props({ loading: false }),
      controller({
        initialPosition: initialPosition({
          phase: "revealing",
          contentVisible: false,
          contentInteractive: false,
          auroraVisible: true,
        }),
      }),
      () => React.createElement("virtual-rows"),
    ))
    expect(content()).toHaveClass("opacity-0")
    expect(content()).not.toHaveClass("transition-opacity", "duration-300")
    const boundary = renderer.container.querySelector("[data-message-scroller-boundary]")!
    expect(boundary).toHaveClass("isolate")
    expect(renderer.getByTestId("community-message-scroller")).toHaveClass("relative", "z-10")
    expect(boundary.querySelector("accessory-rail")).not.toBeInTheDocument()
    expect(content()).toHaveAttribute("aria-hidden", "true")
    expect(content()).toHaveAttribute("inert")

    renderer.rerender(renderMessageListView(
      props({ loading: false }),
      controller({ initialPosition: initialPosition({ phase: "revealing" }) }),
      () => React.createElement("virtual-rows"),
    ))
    expect(content()).toHaveClass("opacity-100", "transition-opacity", "duration-300")
    expect(content()).toHaveAttribute("aria-hidden", "false")
    expect(content()).not.toHaveAttribute("inert")
    expect(renderer.container.querySelector("[data-message-positioning-skeleton]")).toHaveClass("opacity-0")
  })

  it("keeps typing ownership out of the message list", () => {
    const renderer = render(renderMessageListView(
      props({ loading: false }),
      controller({ isLoading: false, pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    expect(mockedRail).toHaveBeenLastCalledWith(expect.objectContaining({ scrollCount: 0 }), undefined)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    expect(JSON.stringify(mockedRail.mock.calls.at(-1)?.[0])).not.toContain("typing")
  })

  it("keeps only the normal tail inset across scroll and selection state", () => {
    const renderer = render(renderMessageListView(
      props(),
      controller({ pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    const content = () => renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    for (const state of [
      { pillCount: 0, selectMode: false },
      { pillCount: 2, selectMode: false },
      { pillCount: 0, selectMode: true },
    ]) {
      expect(content()).toHaveClass("pb-4", "sm:pb-6")
      expect(content()).not.toHaveClass("pb-14", "sm:pb-18")
      renderer.rerender(renderMessageListView(
        props(),
        controller({ pillCount: state.pillCount, selectMode: state.selectMode }),
        () => React.createElement("virtual-rows"),
      ))
    }
    expect(content()).toHaveClass("pb-4", "sm:pb-6")
  })

  it("wires selection actions and dialog close without changing overlay order", () => {
    const exitSelect = vi.fn()
    const setShareOpen = vi.fn()
    const closeShare = vi.fn()
    const state = controller({
      selectMode: true,
      selectedIds: new Set(["m1"]),
      selectedMessages: props().messages,
      shareOpen: true,
      exitSelect,
      setShareOpen,
      closeShare,
    })
    const footerSlot = document.createElement("div")
    document.body.appendChild(footerSlot)
    const renderer = render(renderMessageListView(
      props(),
      state,
      () => React.createElement("virtual-rows"),
      footerSlot,
    ))
    expect(mockedRail).not.toHaveBeenCalled()
    expect(footerSlot.querySelector("[data-selection='active']")).not.toBeNull()
    const cancel = footerSlot.querySelector<HTMLButtonElement>(
      '[aria-label="Cancel message selection"]',
    )!
    const share = footerSlot.querySelector<HTMLButtonElement>(
      '[aria-label="Share 1 selected messages as image"]',
    )!
    cancel.click()
    expect(exitSelect).toHaveBeenCalledOnce()
    share.click()
    expect(setShareOpen).toHaveBeenCalledWith(true)
    expect(mockedShareDialog).toHaveBeenCalledWith(expect.objectContaining({
      m: state.selectedMessages,
      open: true,
      onClose: closeShare,
    }), undefined)
    mockedShareDialog.mock.calls.at(-1)![0].onClose()
    expect(closeShare).toHaveBeenCalledOnce()
    expect(renderer.container.querySelectorAll("accessory-rail")).toHaveLength(0)
    footerSlot.remove()
  })

  it("keeps both sentinels and the direct rows callback in the exact loaded DOM positions", () => {
    const state = controller({
      topSentinelRef: { current: null },
      bottomSentinelRef: { current: null },
      scrollRef: { current: null },
      heroRef: { current: null },
    })
    const renderRows = vi.fn(() => React.createElement("virtual-rows", { marker: "rows" }))
    const renderer = render(renderMessageListView(
      props({
        hasMore: true,
        isFetchingOlder: true,
        hasMoreNewer: true,
        isFetchingNewer: true,
      }),
      state,
      renderRows,
    ))
    const heroNode = renderer.container.querySelector(".mb-6")
    const scrollNode = renderer.container.querySelector(".overflow-y-auto")
    const topNode = renderer.container.querySelector(".flex.h-8")
    const bottomNode = renderer.container.querySelector(".mt-6.flex.h-8")
    expect(state.heroRef.current).toBe(heroNode)
    expect(state.scrollRef.current).toBe(scrollNode)
    expect(state.topSentinelRef.current).toBe(topNode)
    expect(state.bottomSentinelRef.current).toBe(bottomNode)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelector('virtual-rows[marker="rows"]')).toBeInTheDocument()
    expect(renderer.getByText("Loading older messages…")).toBeInTheDocument()
    expect(renderer.getByText("Loading newer messages…")).toBeInTheDocument()

    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(content).toHaveClass("pb-4", "sm:pb-6")
    const elementChildren = Array.from(content.children)
    expect(elementChildren).toHaveLength(3)
    expect(elementChildren[0]).toHaveClass("mb-6")
    expect(elementChildren[1]?.localName).toBe("virtual-rows")
    expect(elementChildren[2]).toHaveClass("mt-6")

    renderer.rerender(renderMessageListView(
      props({
        hasMore: true,
        isFetchingOlder: false,
        hasMoreNewer: true,
        isFetchingNewer: false,
      }),
      state,
      renderRows,
    ))
    expect(renderer.queryAllByText("Loading older messages…")).toHaveLength(0)
    expect(renderer.queryAllByText("Loading newer messages…")).toHaveLength(0)
    expect(renderer.container.querySelectorAll(".flex.h-8")).toHaveLength(2)
    expect(renderer.container.querySelectorAll(".mt-6.flex.h-8")).toHaveLength(1)

    renderer.rerender(renderMessageListView(
      props({ hasMore: false, hasMoreNewer: false }),
      state,
      renderRows,
    ))
    expect(renderer.container.querySelectorAll(".flex.h-8")).toHaveLength(0)
    expect(renderer.container.querySelectorAll(".mt-6.flex.h-8")).toHaveLength(0)
  })
})
