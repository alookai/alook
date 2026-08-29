import React from "react"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useMessageListController, type MessageListController } from "./message-list-controller"
import type { ResolvedMessageListProps } from "./message-list-types"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const readWebSource = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

const mocks = vi.hoisted(() => ({
  hookOrder: [] as string[],
  scrollInputs: [] as unknown[],
  sentinelInputs: [] as unknown[],
  sentinelRefs: [] as Array<{ current: null }>,
  scrollRef: { current: null as HTMLDivElement | null },
  virtualizer: { scrollToOffset: vi.fn(), containerRef: { current: null } },
  jumpToIndex: vi.fn(),
  scrollToBottom: vi.fn(),
  onImageLoad: vi.fn(),
}))

vi.mock("@/hooks/community/use-scroll-anchor", () => ({
  useScrollAnchor: (input: unknown) => {
    mocks.hookOrder.push("anchor")
    mocks.scrollInputs.push(input)
    return {
      scrollRef: mocks.scrollRef,
      virtualizer: mocks.virtualizer,
      belowCount: 2,
      scrollToBottom: mocks.scrollToBottom,
      jumpTo: mocks.jumpToIndex,
      onImageLoad: mocks.onImageLoad,
    }
  },
}))
vi.mock("@/hooks/community/use-virtual-cursor-sentinel", () => ({
  useVirtualCursorSentinel: (input: { edge: string }) => {
    mocks.hookOrder.push(input.edge)
    mocks.sentinelInputs.push(input)
    const ref = { current: null }
    mocks.sentinelRefs.push(ref)
    return ref
  },
}))

const baseMessage = {
  id: "m1",
  type: "chat" as const,
  authorId: "u1",
  authorName: "Alice",
  content: "one",
  createdAt: new Date(0).toISOString(),
}

function props(overrides: Partial<ResolvedMessageListProps> = {}): ResolvedMessageListProps {
  return {
    channel: "general",
    messages: [baseMessage],
    onOpenThread: vi.fn(),
    variant: "channel",
    initialScrollReady: true,
    ...overrides,
  }
}

let latest: MessageListController
function Probe({
  value,
  attachHero = true,
}: {
  value: ResolvedMessageListProps
  attachHero?: boolean
}) {
  const controller = useMessageListController(value)
  React.useLayoutEffect(() => { latest = controller }, [controller])
  return React.createElement(
    React.Fragment,
    null,
    attachHero ? React.createElement("div", { id: "hero", ref: controller.heroRef }) : null,
    React.createElement("div", { id: "scroll", ref: controller.scrollRef }),
  )
}

describe("useMessageListController", () => {
  let resizeCallback: ((entries: Array<{ borderBoxSize?: Array<{ blockSize: number }> }>) => void) | null
  let nextFrameId: number
  let frameCallbacks: Map<number, FrameRequestCallback>
  let requestFrame: ReturnType<typeof vi.fn>
  let cancelFrame: ReturnType<typeof vi.fn>
  let visibleMessageIds: string[]
  let selectionRailTop: number | null
  let selectedRowBottom: number
  const disconnect = vi.fn()
  const heroNode = { offsetHeight: 0 }
  const scrollNode = {
    scrollTop: 0,
    scrollHeight: 3206,
    clientHeight: 692,
    isConnected: true,
    parentElement: {
      querySelector: () => selectionRailTop === null ? null : ({
        getBoundingClientRect: () => ({ top: selectionRailTop }),
      }),
    },
    querySelectorAll: () => visibleMessageIds.map((id) => ({
      dataset: { msgId: id },
      getBoundingClientRect: () => ({ top: 10, bottom: selectedRowBottom }),
    })),
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  }

  beforeEach(() => {
    resizeCallback = null
    disconnect.mockClear()
    mocks.hookOrder.length = 0
    mocks.scrollInputs.length = 0
    mocks.sentinelInputs.length = 0
    mocks.sentinelRefs.length = 0
    mocks.scrollRef.current = null
    mocks.jumpToIndex.mockClear()
    mocks.scrollToBottom.mockClear()
    mocks.virtualizer.scrollToOffset.mockClear()
    nextFrameId = 0
    frameCallbacks = new Map()
    visibleMessageIds = ["m1"]
    selectionRailTop = null
    selectedRowBottom = 20
    scrollNode.scrollTop = 0
    scrollNode.clientHeight = 692
    heroNode.offsetHeight = 0
    requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frameCallbacks.set(id, callback)
      return id
    })
    cancelFrame = vi.fn((id: number) => frameCallbacks.delete(id))
    vi.useFakeTimers()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: typeof resizeCallback) { resizeCallback = callback }
      observe() {}
      disconnect() { disconnect() }
    })
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
      requestAnimationFrame: requestFrame,
      cancelAnimationFrame: cancelFrame,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const createNodeMock = (element: { props?: { id?: string } }) => (
    element.props?.id === "hero" ? heroNode : scrollNode
  )

  const runNextFrame = () => {
    const entry = frameCallbacks.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!entry) throw new Error("expected a pending animation frame")
    frameCallbacks.delete(entry[0])
    act(() => entry[1](0))
    return entry[0]
  }

  it("uses the exact loading predicate and calls anchor/start/end hooks unconditionally in order", () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props({ loading: true }) }),
        { createNodeMock },
      )
    })
    expect(latest.isLoading).toBe(false)
    expect(mocks.hookOrder.slice(0, 3)).toEqual(["anchor", "start", "end"])
    expect(mocks.scrollInputs[0]).toEqual({
      items: expect.any(Array),
      newDividerBefore: undefined,
      initialScrollReady: true,
      hasMoreNewer: undefined,
      presentVersion: undefined,
      viewerUserId: undefined,
      heroHeight: 0,
      heroMeasured: false,
    })
    expect(mocks.sentinelInputs.slice(0, 2)).toEqual([
      {
        scrollRef: mocks.scrollRef,
        hasMore: undefined,
        isFetching: undefined,
        onLoad: undefined,
        edge: "start",
      },
      {
        scrollRef: mocks.scrollRef,
        hasMore: undefined,
        isFetching: undefined,
        onLoad: undefined,
        edge: "end",
      },
    ])
    expect(latest.scrollRef).toBe(mocks.scrollRef)
    expect(latest.virtualizer).toBe(mocks.virtualizer)
    expect(latest.topSentinelRef).toBe(mocks.sentinelRefs.at(-2))
    expect(latest.bottomSentinelRef).toBe(mocks.sentinelRefs.at(-1))
    expect(latest.onImageLoad).toBe(mocks.onImageLoad)
    expect(latest.pillCount).toBe(2)
    expect(latest.pillMode).toBe("scroll")
    expect(latest.pillOnClick).toBe(mocks.scrollToBottom)
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ loading: true, messages: [] }),
      }))
    })
    expect(latest.isLoading).toBe(true)
    expect(mocks.hookOrder.slice(-3)).toEqual(["anchor", "start", "end"])
  })

  it("passes every pagination/anchor input through and gives jump mode server-count precedence", () => {
    const loadOlder = vi.fn()
    const loadNewer = vi.fn()
    const jumpToPresent = vi.fn()
    act(() => {
      TestRenderer.create(React.createElement(Probe, {
        value: props({
          newDividerBefore: "m1",
          initialScrollReady: false,
          hasMore: true,
          isFetchingOlder: true,
          onLoadOlder: loadOlder,
          hasMoreNewer: true,
          isFetchingNewer: true,
          onLoadNewer: loadNewer,
          onJumpToPresent: jumpToPresent,
          presentVersion: 7,
          unreadCount: 9,
          viewerUserId: "viewer_1",
        }),
      }), { createNodeMock })
    })
    expect(mocks.scrollInputs.at(-1)).toEqual({
      items: expect.any(Array),
      newDividerBefore: "m1",
      initialScrollReady: false,
      hasMoreNewer: true,
      presentVersion: 7,
      viewerUserId: "viewer_1",
      heroHeight: 0,
      heroMeasured: true,
    })
    expect(mocks.sentinelInputs.slice(-2)).toEqual([
      {
        scrollRef: mocks.scrollRef,
        hasMore: true,
        isFetching: true,
        onLoad: loadOlder,
        edge: "start",
      },
      {
        scrollRef: mocks.scrollRef,
        hasMore: true,
        isFetching: true,
        onLoad: loadNewer,
        edge: "end",
      },
    ])
    expect(latest.pillCount).toBe(9)
    expect(latest.pillMode).toBe("jump")
    expect(latest.pillOnClick).toBe(jumpToPresent)
    act(() => latest.pillOnClick())
    expect(jumpToPresent).toHaveBeenCalledOnce()
  })

  it("publishes scroll roots cleanup-first and measures zero-height heroes immediately", () => {
    const first = vi.fn()
    const second = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props({ onScrollRoot: first }) }),
        { createNodeMock },
      )
    })
    expect((mocks.scrollInputs.at(-1) as { heroHeight: number; heroMeasured: boolean }))
      .toEqual(expect.objectContaining({ heroHeight: 0, heroMeasured: true }))
    expect(first).toHaveBeenCalledWith(scrollNode)

    act(() => {
      renderer!.update(React.createElement(Probe, { value: props({ onScrollRoot: second }) }))
    })
    expect(first.mock.calls.at(-1)).toEqual([null])
    expect(second).toHaveBeenCalledWith(scrollNode)
    expect(first.mock.invocationCallOrder.at(-1)!).toBeLessThan(second.mock.invocationCallOrder[0])

    act(() => resizeCallback?.([{ borderBoxSize: [{ blockSize: 42 }] }]))
    expect((mocks.scrollInputs.at(-1) as { heroHeight: number; heroMeasured: boolean }))
      .toEqual(expect.objectContaining({ heroHeight: 42, heroMeasured: true }))
    heroNode.offsetHeight = 17
    act(() => resizeCallback?.([{}]))
    expect((mocks.scrollInputs.at(-1) as { heroHeight: number; heroMeasured: boolean }))
      .toEqual(expect.objectContaining({ heroHeight: 17, heroMeasured: true }))
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ loading: true, messages: [], onScrollRoot: second, hero: "changed" }),
      }))
    })
    expect((mocks.scrollInputs.at(-1) as { heroMeasured: boolean }).heroMeasured).toBe(true)
    act(() => renderer!.unmount())
    expect(disconnect).toHaveBeenCalled()
  })

  it("combines initial readiness with loaded-target readiness and preserves state across channel-only changes", () => {
    const consumed = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(Probe, {
        value: props({ scrollToMessageId: "m2", onScrollTargetConsumed: consumed }),
      }), { createNodeMock })
    })
    expect((mocks.scrollInputs.at(-1) as { initialScrollReady: boolean }).initialScrollReady).toBe(false)
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({
          messages: [baseMessage, { ...baseMessage, id: "m2" }],
          scrollToMessageId: "m2",
          onScrollTargetConsumed: consumed,
        }),
      }))
    })
    expect((mocks.scrollInputs.at(-1) as { initialScrollReady: boolean }).initialScrollReady).toBe(true)
    expect(consumed).toHaveBeenCalledOnce()
    visibleMessageIds = ["m2"]
    runNextFrame()
    act(() => {
      latest.onEnterSelectId("m2")
      latest.setShareOpen(true)
    })
    expect(latest.jumped).toBe("m2")
    expect(latest.selectedIds).toEqual(new Set(["m2"]))
    expect(latest.shareOpen).toBe(true)

    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({
          channel: "random",
          messages: [baseMessage, { ...baseMessage, id: "m2" }],
          scrollToMessageId: "m2",
          onScrollTargetConsumed: consumed,
        }),
      }))
    })
    expect(latest.jumped).toBe("m2")
    expect(latest.selectedIds).toEqual(new Set(["m2"]))
    expect(latest.shareOpen).toBe(true)
    expect(consumed).toHaveBeenCalledOnce()

    act(() => latest.closeShare())
    expect(latest.shareOpen).toBe(false)
    expect(latest.selectMode).toBe(false)
    expect(latest.selectedIds).toEqual(new Set())

    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ initialScrollReady: false, scrollToMessageId: null }),
      }))
    })
    expect((mocks.scrollInputs.at(-1) as { initialScrollReady: boolean }).initialScrollReady).toBe(false)
    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({
          messages: [baseMessage, { ...baseMessage, id: "m2" }],
          scrollToMessageId: "m2",
          onScrollTargetConsumed: consumed,
        }),
      }))
    })
    expect(consumed).toHaveBeenCalledTimes(2)
  })

  it("keeps selected-message regrouping asymmetric around replies", () => {
    const reply = { ...baseMessage, id: "reply", replyTo: { id: "p", authorName: "P", text: "x" } }
    const ordinary = { ...baseMessage, id: "ordinary", createdAt: new Date(1000).toISOString() }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props({ messages: [reply, ordinary] }) }),
        { createNodeMock },
      )
    })
    act(() => {
      latest.onEnterSelectId("reply")
      latest.onToggleSelectId("ordinary")
    })
    expect(latest.selectedMessages.map((message) => [message.id, message.grouped]))
      .toEqual([["reply", false], ["ordinary", true]])

    act(() => {
      renderer!.update(React.createElement(Probe, {
        value: props({ messages: [ordinary, reply] }),
      }))
      latest.onEnterSelectId("ordinary")
      latest.onToggleSelectId("reply")
    })
    expect(latest.selectedMessages.map((message) => [message.id, message.grouped]))
      .toEqual([["ordinary", false], ["reply", false]])
  })

  it("regroups selected messages by stable author id despite stale raw names", () => {
    const first = { ...baseMessage, id: "first", authorName: "Old Alice" }
    const second = {
      ...baseMessage,
      id: "second",
      authorName: "New Alice",
      createdAt: new Date(1000).toISOString(),
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props({ messages: [first, second] }) }),
        { createNodeMock },
      )
    })
    act(() => {
      latest.onEnterSelectId("first")
      latest.onToggleSelectId("second")
    })

    expect(latest.selectedMessages.map((message) => [message.id, message.grouped]))
      .toEqual([["first", false], ["second", true]])
    act(() => renderer.unmount())
  })

  it("falls back to author name when selected legacy messages have no author id", () => {
    const first = { ...baseMessage, id: "first", authorId: undefined }
    const second = {
      ...baseMessage,
      id: "second",
      authorId: undefined,
      createdAt: new Date(1000).toISOString(),
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props({ messages: [first, second] }) }),
        { createNodeMock },
      )
    })
    act(() => {
      latest.onEnterSelectId("first")
      latest.onToggleSelectId("second")
    })

    expect(latest.selectedMessages.map((message) => [message.id, message.grouped]))
      .toEqual([["first", false], ["second", true]])
    act(() => renderer.unmount())
  })

  it("minimally scrolls an overlapping selected row above the active accessory rail", () => {
    selectionRailTop = 692
    selectedRowBottom = 747.5
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props() }),
        { createNodeMock },
      )
    })

    act(() => latest.onEnterSelectId("m1"))
    runNextFrame()

    expect(scrollNode.scrollTop).toBe(63.5)
    selectedRowBottom = 684
    runNextFrame()
    selectionRailTop = null
    runNextFrame()
    act(() => renderer!.unmount())
  })

  it("minimally scrolls a selected row when its non-overlapping rail gap is under 8px", () => {
    selectionRailTop = 692
    selectedRowBottom = 688
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props() }),
        { createNodeMock },
      )
    })

    act(() => latest.onEnterSelectId("m1"))
    runNextFrame()

    expect(scrollNode.scrollTop).toBe(4)
    selectedRowBottom = 684
    runNextFrame()
    expect(scrollNode.scrollTop).toBe(4)
    runNextFrame()
    expect(frameCallbacks.size).toBe(0)
    act(() => renderer!.unmount())
  })

  it("closes the share dialog before exiting selection mode", () => {
    const source = readWebSource(
      "src/components/community/messages/message-list-controller.ts",
    )
    const closeShare = source.slice(
      source.indexOf("const closeShare = useCallback"),
      source.indexOf("return {", source.indexOf("const closeShare = useCallback")),
    )
    expect(closeShare.indexOf("setShareOpen(false)")).toBeGreaterThan(-1)
    expect(closeShare.indexOf("setShareOpen(false)")).toBeLessThan(
      closeShare.indexOf("exitSelect()"),
    )
  })

  it("consumes a loaded target after zero-height measurement and clears highlight after visibility", () => {
    const consumed = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, {
          value: props({ scrollToMessageId: "m1", onScrollTargetConsumed: consumed }),
        }),
        { createNodeMock },
      )
    })
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("m1", "auto")
    expect(consumed).toHaveBeenCalledWith("m1")
    expect(latest.jumped).toBe("m1")
    runNextFrame()
    act(() => vi.advanceTimersByTime(1599))
    expect(latest.jumped).toBe("m1")
    act(() => vi.advanceTimersByTime(1))
    expect(latest.jumped).toBeNull()
    act(() => renderer!.unmount())
  })

  it("does not consume a loaded target until the hero ref has been measured", () => {
    const consumed = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, {
          attachHero: false,
          value: props({ scrollToMessageId: "m1", onScrollTargetConsumed: consumed }),
        }),
        { createNodeMock },
      )
    })
    expect(mocks.jumpToIndex).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()

    act(() => {
      renderer!.update(React.createElement(Probe, {
        attachHero: true,
        value: props({
          hero: "mounted",
          scrollToMessageId: "m1",
          onScrollTargetConsumed: consumed,
        }),
      }))
    })
    expect(mocks.jumpToIndex).toHaveBeenCalledWith("m1", "auto")
    expect(consumed).toHaveBeenCalledWith("m1")
    act(() => renderer!.unmount())
  })

  it("bounds invisible-target polling and gives the newest pending frame and timer ownership", () => {
    visibleMessageIds = []
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props() }),
        { createNodeMock },
      )
    })
    act(() => latest.jumpTo("m1", "auto"))
    for (let index = 0; index < 120; index += 1) runNextFrame()
    expect(requestFrame).toHaveBeenCalledTimes(120)
    expect(frameCallbacks.size).toBe(0)
    expect(latest.jumped).toBe("m1")
    act(() => vi.advanceTimersByTime(1600))
    expect(latest.jumped).toBeNull()

    visibleMessageIds = []
    act(() => latest.jumpTo("m1", "smooth"))
    const replacedFrame = [...frameCallbacks.keys()][0]
    act(() => latest.jumpTo("m2", "smooth"))
    expect(cancelFrame).toHaveBeenCalledWith(replacedFrame)
    expect(frameCallbacks.has(replacedFrame)).toBe(false)
    expect(latest.jumped).toBe("m2")
    visibleMessageIds = ["m2"]
    runNextFrame()

    act(() => vi.advanceTimersByTime(400))
    visibleMessageIds = ["m1"]
    act(() => latest.jumpTo("m1", "smooth"))
    runNextFrame()
    expect(vi.getTimerCount()).toBe(1)
    act(() => vi.advanceTimersByTime(1200))
    expect(latest.jumped).toBe("m1")
    act(() => vi.advanceTimersByTime(399))
    expect(latest.jumped).toBe("m1")
    act(() => vi.advanceTimersByTime(1))
    expect(latest.jumped).toBeNull()
    expect(mocks.jumpToIndex.mock.calls.slice(-3)).toEqual([
      ["m1", "smooth"],
      ["m2", "smooth"],
      ["m1", "smooth"],
    ])

    act(() => latest.jumpTo("m1"))
    runNextFrame()
    expect(vi.getTimerCount()).toBe(1)
    act(() => renderer!.unmount())
    expect(vi.getTimerCount()).toBe(0)

    visibleMessageIds = []
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(Probe, { value: props() }),
        { createNodeMock },
      )
    })
    act(() => latest.jumpTo("m1"))
    const pendingFrame = [...frameCallbacks.keys()][0]
    act(() => renderer!.unmount())
    expect(cancelFrame).toHaveBeenCalledWith(pendingFrame)
    expect(vi.getTimerCount()).toBe(0)
  })
})
