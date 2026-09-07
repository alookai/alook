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
}))
vi.mock("./message-share-dialog", () => ({ MessageShareDialog: vi.fn(() => null) }))
vi.mock("@/components/ui/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => React.createElement("ticker", { value }),
}))

const mockedRail = vi.mocked(ComposerAccessoryRail)
const mockedShareDialog = vi.mocked(MessageShareDialog)

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
    typingUsers: ["Alice"],
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

  it("keeps warm non-empty loading data on the loaded DOM with live typing and pill", () => {
    const listProps = props()
    const state = controller()
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(listProps, state, renderRows))
    expect(mockedRail).toHaveBeenCalledWith(expect.objectContaining({
      typingNames: ["Alice"],
      scrollCount: 3,
      selectMode: false,
    }), undefined)
    const scrollerBoundary = renderer.container.querySelector("[data-message-scroller-boundary]")!
    expect(scrollerBoundary.querySelectorAll("accessory-rail")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelectorAll("virtual-rows")).toHaveLength(1)
    expect(renderer.container.querySelectorAll(".mb-6")).toHaveLength(1)
  })

  it("keeps the same wrappers while true empty loading omits the interactive accessory rail", () => {
    const listProps = props({ messages: [] })
    const state = controller({ isLoading: true, pillCount: 8 })
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(listProps, state, renderRows))
    expect(renderer.container.firstElementChild).toHaveClass(
      "relative", "flex", "min-h-0", "flex-1", "flex-col",
    )
    expect(mockedRail).not.toHaveBeenCalled()
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderer.container.querySelectorAll(".mb-6")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
  })

  it("routes typing through the rail without adding a dynamic flex sibling", () => {
    const renderer = render(renderMessageListView(
      props({ loading: false, typingUsers: [] }),
      controller({ isLoading: false, pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    expect(mockedRail).toHaveBeenLastCalledWith(expect.objectContaining({ typingNames: [] }), undefined)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    renderer.rerender(renderMessageListView(
      props({ loading: false, typingUsers: ["Alice"] }),
      controller({ isLoading: false, pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    expect(mockedRail).toHaveBeenLastCalledWith(expect.objectContaining({
      typingNames: ["Alice"],
    }), undefined)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
  })

  it("keeps one fixed responsive tail safe area across every rail state", () => {
    const renderer = render(renderMessageListView(
      props({ typingUsers: [] }),
      controller({ pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    const content = () => renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    for (const state of [
      { typingUsers: ["Alice"], pillCount: 0, selectMode: false },
      { typingUsers: [], pillCount: 2, selectMode: false },
      { typingUsers: ["Alice"], pillCount: 2, selectMode: false },
      { typingUsers: ["Alice"], pillCount: 0, selectMode: true },
    ]) {
      expect(content()).toHaveClass("pb-14", "sm:pb-18")
      expect(content()).not.toHaveClass("pb-8")
      renderer.rerender(renderMessageListView(
        props({ typingUsers: state.typingUsers }),
        controller({ pillCount: state.pillCount, selectMode: state.selectMode }),
        () => React.createElement("virtual-rows"),
      ))
    }
    expect(content()).toHaveClass("pb-14", "sm:pb-18")
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
    const renderer = render(renderMessageListView(
      props(),
      state,
      () => React.createElement("virtual-rows"),
    ))
    const railProps = mockedRail.mock.calls.at(-1)![0]
    expect(railProps).toMatchObject({
      selectMode: true,
      selectedCount: 1,
    })
    railProps.onCancelSelection()
    expect(exitSelect).toHaveBeenCalledOnce()
    railProps.onShareSelection()
    expect(setShareOpen).toHaveBeenCalledWith(true)
    expect(mockedShareDialog).toHaveBeenCalledWith(expect.objectContaining({
      m: state.selectedMessages,
      open: true,
      onClose: closeShare,
    }), undefined)
    mockedShareDialog.mock.calls.at(-1)![0].onClose()
    expect(closeShare).toHaveBeenCalledOnce()
    expect(renderer.container.querySelectorAll("accessory-rail")).toHaveLength(1)
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
    expect(content).toHaveClass("pb-14", "sm:pb-18")
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
