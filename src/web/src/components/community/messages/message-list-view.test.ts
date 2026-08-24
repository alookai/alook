import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, it, vi } from "vitest"
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderMessageListView(listProps, state, renderRows))
    })
    expect(mockedRail).toHaveBeenCalledWith(expect.objectContaining({
      typingNames: ["Alice"],
      scrollCount: 3,
      selectMode: false,
    }), undefined)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByType("virtual-rows")).toHaveLength(1)
    expect(renderer!.root.findAll((node) => node.props.className === "mb-6")).toHaveLength(1)
  })

  it("keeps the same wrappers while true empty loading omits the interactive accessory rail", () => {
    const listProps = props({ messages: [] })
    const state = controller({ isLoading: true, pillCount: 8 })
    const renderRows = vi.fn(() => React.createElement("virtual-rows"))
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderMessageListView(listProps, state, renderRows))
    })
    expect(renderer!.root.findByType("div").props.className).toBe("relative flex min-h-0 flex-1 flex-col")
    expect(mockedRail).not.toHaveBeenCalled()
    expect(renderRows).not.toHaveBeenCalled()
    expect(renderer!.root.findAll((node) => node.props.className === "mb-6")).toHaveLength(1)
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
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderMessageListView(
        props(),
        state,
        () => React.createElement("virtual-rows"),
      ))
    })
    const rail = renderer!.root.findByType("accessory-rail")
    expect(rail.props).toMatchObject({
      selectMode: true,
      selectedCount: 1,
      typingNames: ["Alice"],
    })
    act(() => rail.props.onCancelSelection())
    expect(exitSelect).toHaveBeenCalledOnce()
    act(() => rail.props.onShareSelection())
    expect(setShareOpen).toHaveBeenCalledWith(true)
    expect(mockedShareDialog).toHaveBeenCalledWith(expect.objectContaining({
      m: state.selectedMessages,
      open: true,
      onClose: closeShare,
    }), undefined)
    act(() => mockedShareDialog.mock.calls.at(-1)![0].onClose())
    expect(closeShare).toHaveBeenCalledOnce()
    expect(renderer!.root.findAllByType("accessory-rail")).toHaveLength(1)
  })

  it("keeps both sentinels and the direct rows callback in the exact loaded DOM positions", () => {
    const topNode = { edge: "top" }
    const bottomNode = { edge: "bottom" }
    const scrollNode = { edge: "scroll" }
    const heroNode = { edge: "hero" }
    const state = controller({
      topSentinelRef: { current: null },
      bottomSentinelRef: { current: null },
      scrollRef: { current: null },
      heroRef: { current: null },
    })
    const renderRows = vi.fn(() => React.createElement("virtual-rows", { marker: "rows" }))
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(renderMessageListView(
        props({
          hasMore: true,
          isFetchingOlder: true,
          hasMoreNewer: true,
          isFetchingNewer: true,
        }),
        state,
        renderRows,
      ), {
        createNodeMock: (element) => {
          const className = element.props.className as string | undefined
          if (className === "mb-6") return heroNode
          if (className?.includes("overflow-y-auto")) return scrollNode
          if (className?.includes("mt-6 flex h-8")) return bottomNode
          if (className?.includes("flex h-8")) return topNode
          return null
        },
      })
    })
    expect(state.heroRef.current).toBe(heroNode)
    expect(state.scrollRef.current).toBe(scrollNode)
    expect(state.topSentinelRef.current).toBe(topNode)
    expect(state.bottomSentinelRef.current).toBe(bottomNode)
    expect(renderRows).toHaveBeenCalledOnce()
    expect(renderer!.root.findByProps({ marker: "rows" })).toBeTruthy()
    expect(renderer!.root.findAllByType("div").some((node) =>
      node.children.includes("Loading older messages…"))).toBe(true)
    expect(renderer!.root.findAllByType("div").some((node) =>
      node.children.includes("Loading newer messages…"))).toBe(true)

    const content = renderer!.root.findByProps({
      className: "flex min-h-full flex-col justify-end px-4 py-8",
    })
    const elementChildren = content.children.filter((child) => typeof child !== "string")
    expect(elementChildren).toHaveLength(3)
    expect(elementChildren[0].props.className).toBe("mb-6")
    expect(elementChildren[1].type).toBe("virtual-rows")
    expect(elementChildren[2].props.className).toContain("mt-6")

    act(() => {
      renderer!.update(renderMessageListView(
        props({
          hasMore: true,
          isFetchingOlder: false,
          hasMoreNewer: true,
          isFetchingNewer: false,
        }),
        state,
        renderRows,
      ))
    })
    expect(renderer!.root.findAll((node) =>
      node.children.includes("Loading older messages…"))).toHaveLength(0)
    expect(renderer!.root.findAll((node) =>
      node.children.includes("Loading newer messages…"))).toHaveLength(0)
    expect(renderer!.root.findAllByProps({
      className: "flex h-8 items-center justify-center text-xs text-muted-foreground",
    })).toHaveLength(1)
    expect(renderer!.root.findAllByProps({
      className: "mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground",
    })).toHaveLength(1)

    act(() => {
      renderer!.update(renderMessageListView(
        props({ hasMore: false, hasMoreNewer: false }),
        state,
        renderRows,
      ))
    })
    expect(renderer!.root.findAllByProps({
      className: "flex h-8 items-center justify-center text-xs text-muted-foreground",
    })).toHaveLength(0)
    expect(renderer!.root.findAllByProps({
      className: "mt-6 flex h-8 items-center justify-center text-xs text-muted-foreground",
    })).toHaveLength(0)
  })
})
