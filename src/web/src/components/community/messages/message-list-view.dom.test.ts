import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render } from "@/test/react-dom-harness"
import { MessageListSkeleton, renderMessageListView as renderView } from "./message-list-view"
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
    scrollRef: { current: null },
    virtualizer: {} as MessageListController["virtualizer"],
    readPositionReady: true,
    jumpTo: vi.fn(),
    pillCount: 3,
    pillMode: "jump",
    pillOnClick: vi.fn(),
    ...overrides,
  } as MessageListController
}

describe("renderMessageListView", () => {
  let accessoryFooterSlot: HTMLDivElement
  function renderMessageListView(...args: Parameters<typeof renderView>) {
    return renderView(args[0], args[1], args[2], args[3], accessoryFooterSlot)
  }
  beforeEach(() => {
    vi.clearAllMocks()
    accessoryFooterSlot = document.createElement("div")
    document.body.appendChild(accessoryFooterSlot)
  })
  afterEach(() => accessoryFooterSlot.remove())

  it("keeps warm non-empty loading data on the loaded DOM with typing and the away pill", () => {
    const listProps = props()
    const state = controller()
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(listProps, state, renderRows))
    expect(mockedRail).toHaveBeenCalledWith(expect.objectContaining({
      typingNames: ["Alice"],
      scrollCount: 3,
    }), undefined)
    expect(mockedRail.mock.calls.at(-1)?.[0]).not.toHaveProperty("composerOverlap")
    const scrollerBoundary = renderer.container.querySelector("[data-message-scroller-boundary]")!
    expect(renderer.container.querySelector("[data-message-list-content]")).toHaveClass(
      "pl-(--community-composer-inline-start)", "pr-(--community-composer-inline-end)",
    )
    expect(scrollerBoundary.querySelectorAll("accessory-rail")).toHaveLength(0)
    expect(accessoryFooterSlot.querySelectorAll("accessory-rail")).toHaveLength(1)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelectorAll("virtual-rows")).toHaveLength(1)
    expect(renderer.container.querySelectorAll(".mb-6")).toHaveLength(0)
  })


  it("does not restore an accessory overlay inside the list while its Footer target is absent", () => {
    const renderer = render(renderView(props(), controller(), () => React.createElement("virtual-rows")))
    expect(mockedRail).not.toHaveBeenCalled()
    expect(renderer.container.querySelector("accessory-rail")).toBeNull()
    expect(renderer.getByTestId("community-message-scroller")).toBeInTheDocument()
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
    expect(content).not.toHaveClass("opacity-0")
    expect(content).not.toHaveClass("transition-opacity", "duration-300")
    expect(content.querySelector("[data-message-list-skeleton-tail]")).toHaveClass("shrink-0")
    expect(content.querySelector("[data-message-list-skeleton-tail]")).toHaveStyle({ height: "40px" })
  })

  it("shows real rows during positioning while retaining separate read eligibility", () => {
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(
      props({ loading: false }),
      controller({ readPositionReady: false, initialPosition: initialPosition({ phase: "positioning" }) }),
      renderRows,
    ))
    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer.container.querySelector("virtual-rows")).toBeInTheDocument()
    expect(content).toHaveAttribute("data-initial-position-phase", "positioning")
    expect(content).toHaveAttribute("data-read-position-ready", "false")
    expect(content).toHaveAttribute("aria-hidden", "false")
    expect(content).not.toHaveAttribute("inert")
    expect(content).not.toHaveClass("opacity-0", "transition-opacity", "duration-300")
    expect(renderer.container.querySelector("[data-message-positioning-skeleton]")).toBeNull()
  })

  it("reserves the shared 40px rail tail in the standalone skeleton", () => {
    const renderer = render(React.createElement(MessageListSkeleton))
    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    const tail = content.querySelector("[data-message-list-skeleton-tail]")

    expect(content).not.toHaveClass("pb-4", "sm:pb-6", "pb-14", "sm:pb-18")
    expect(tail).toHaveAttribute("aria-hidden", "true")
    expect(tail).toHaveClass("shrink-0")
    expect(tail).toHaveStyle({ height: "40px" })
    expect(content).toHaveClass("pl-(--community-composer-inline-start)", "pr-(--community-composer-inline-end)")
  })

  it("updates read readiness without an opacity overlay or fade", () => {
    const renderer = render(renderMessageListView(
      props({ loading: false }),
      controller({ readPositionReady: false, initialPosition: initialPosition({ phase: "positioning" }) }),
      () => React.createElement("virtual-rows"),
    ))
    const content = renderer.container.querySelector<HTMLElement>("[data-message-list-content]")!
    expect(content).toHaveAttribute("data-read-position-ready", "false")
    renderer.rerender(renderMessageListView(
      props({ loading: false }), controller(), () => React.createElement("virtual-rows"),
    ))
    expect(content).toHaveAttribute("data-read-position-ready", "true")
    expect(content).not.toHaveClass("opacity-0", "transition-opacity", "duration-300")
    expect(content).not.toHaveAttribute("inert")
    expect(renderer.container.querySelector("[data-message-positioning-skeleton]")).toBeNull()
  })

  it("routes typing through the rail without adding a dynamic flex sibling", () => {
    const renderer = render(renderMessageListView(
      props({ loading: false, typingUsers: [] }),
      controller({ isLoading: false, pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    expect(mockedRail).toHaveBeenLastCalledWith(expect.objectContaining({
      typingNames: [],
      scrollCount: 0,
    }), undefined)
    expect(renderer.container.querySelectorAll("[data-message-typing-space]")).toHaveLength(0)
    renderer.rerender(renderMessageListView(
      props({ loading: false, typingUsers: ["Alice"] }),
      controller({ isLoading: false, pillCount: 0 }),
      () => React.createElement("virtual-rows"),
    ))
    expect(mockedRail).toHaveBeenLastCalledWith(expect.objectContaining({
      typingNames: ["Alice"],
    }), undefined)
  })

  it("leaves tail spacing to the virtualizer across scroll and selection state", () => {
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
      expect(content()).not.toHaveClass("pb-4", "sm:pb-6", "pb-14", "sm:pb-18")
      renderer.rerender(renderMessageListView(
        props(),
        controller({ pillCount: state.pillCount, selectMode: state.selectMode }),
        () => React.createElement("virtual-rows"),
      ))
    }
    expect(content()).not.toHaveClass("pb-4", "sm:pb-6")
  })

  it("wires selection actions through the footer slot and closes the share dialog", () => {
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

  it("keeps nonempty content at the native origin with edges delegated to rows", () => {
    const state = controller({ readPositionReady: false })
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const renderer = render(renderMessageListView(props({ hasMore: true, hasMoreNewer: true }), state, renderRows))
    const content = renderer.container.querySelector("[data-message-list-content]")!
    expect(content.children).toHaveLength(1)
    expect(content).not.toHaveClass("pt-8", "justify-end", "min-h-full")
    expect(content).toHaveAttribute("data-read-position-ready", "false")
    expect(renderer.queryByText(/Beginning of the channel/)).toBeNull()
    expect(renderer.container.querySelectorAll(".h-8")).toHaveLength(0)
    renderer.rerender(renderMessageListView(props({ messages: [], historyStartKnown: true }), state, renderRows))
    expect(content).toHaveClass("pt-8", "justify-end", "min-h-full")
    expect(renderer.getByText(/Beginning of the channel/)).toBeInTheDocument()
    renderer.rerender(renderMessageListView(props({ messages: [] }), state, renderRows))
    expect(renderer.queryByText(/Beginning of the channel/)).toBeNull()
  })

  it("keeps the original scroller mounted through a cold error and retry, without rendering an empty hero", () => {
    const retry = vi.fn()
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    const state = controller({ initialPosition: initialPosition({ phase: "skeleton", showSkeleton: true, contentVisible: false, contentInteractive: false }) })
    const input = props({ messages: [], initialLoadError: new Error("timeout"), onRetryInitialLoad: retry })
    const view = render(renderMessageListView(input, state, renderRows))
    const scroller = view.container.querySelector('[data-testid="community-message-scroller"]') ?? view.container.querySelector('.thin-scrollbar')
    fireEvent.click(view.getByRole("button", { name: "Retry" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(renderRows).not.toHaveBeenCalled()
    expect(view.queryByText(/Beginning of the channel/)).toBeNull()
    view.rerender(renderMessageListView({ ...input, retryingInitialLoad: true }, state, renderRows))
    expect(view.getByRole("button", { name: "Retrying…" })).toBeDisabled()
    expect(view.container.querySelector('.thin-scrollbar')).toBe(scroller)
    view.rerender(renderMessageListView(props({ loading: false }), controller(), renderRows))
    expect(view.container.querySelector('.thin-scrollbar')).toBe(scroller)
    expect(view.queryByRole("alert")).toBeNull()
    expect(renderRows).toHaveBeenCalledOnce()
  })

})
