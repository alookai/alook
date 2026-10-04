import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VirtualizerOptions } from "@tanstack/react-virtual"
import type { FlatItem } from "@/lib/community/message-list-items"
import { createElement, useLayoutEffect } from "react"
import { act, render } from "@/test/react-dom-harness"

let resizeCallbacks: ResizeObserverCallback[] = []
let mutationCallbacks: MutationCallback[] = []
const nativeWindow = window
function stubWindow(options: Partial<Window>) {
  vi.stubGlobal("window", new Proxy(nativeWindow, { get(target, key) {
    return key in options ? Reflect.get(options, key) : Reflect.get(target, key, target)
  } }))
}

const virtualizer = {
  options: { anchorTo: "end" },
  isAtEnd: vi.fn(() => true),
  scrollToEnd: vi.fn(),
  scrollToIndex: vi.fn(),
  scrollToOffset: vi.fn(),
  getTotalSize: vi.fn(() => 1_600),
  range: null,
  shouldAdjustScrollPositionOnItemSizeChange: undefined,
}
let virtualizerOptions: VirtualizerOptions<HTMLDivElement, Element> | undefined

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: VirtualizerOptions<HTMLDivElement, Element>) => {
    virtualizerOptions = options
    return virtualizer
  },
}))

function resetHarness() {
  resizeCallbacks = []
  mutationCallbacks = []
  virtualizerOptions = undefined
  virtualizer.options.anchorTo = "end"
  virtualizer.isAtEnd.mockReturnValue(true)
  virtualizer.scrollToEnd.mockReset()
  virtualizer.scrollToIndex.mockReset()
  virtualizer.scrollToOffset.mockReset()
  virtualizer.getTotalSize.mockReset().mockReturnValue(1_600)
  stubWindow({
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  })
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback)
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: MutationCallback) {
      mutationCallbacks.push(callback)
    }

    observe() {}
    disconnect() {}
    takeRecords() { return [] }
  })
}

async function mountHook({
  distanceToEnd = 0,
  initialClientHeight = 800,
  initialScrollHeight = 1_600,
  items = [] as FlatItem[],
  initialScrollReady = false,
  heroMeasured = false,
  newDividerBefore,
  hasMoreNewer,
  presentVersion,
  viewerUserId,
  onInitialPositionSettled,
  tailPaddingEnd = 48,
  scrollToMessageId,
  onScrollTargetPositioned,
}: {
  distanceToEnd?: number
  initialClientHeight?: number
  initialScrollHeight?: number
  items?: FlatItem[]
  initialScrollReady?: boolean
  heroMeasured?: boolean
  newDividerBefore?: string
  hasMoreNewer?: boolean
  presentVersion?: number
  viewerUserId?: string
  onInitialPositionSettled?: () => void
  tailPaddingEnd?: number
  scrollToMessageId?: string | null
  onScrollTargetPositioned?: (id: string) => void
} = {}) {
  const { useScrollAnchor } = await import("./use-scroll-anchor")
  const hookInput = {
    items,
    initialScrollReady,
    heroHeight: 0,
    heroMeasured,
    newDividerBefore,
    hasMoreNewer,
    presentVersion,
    viewerUserId,
    onInitialPositionSettled,
    tailPaddingEnd,
    scrollToMessageId,
    onScrollTargetPositioned,
    isFetchingOlder: false,
    isFetchingNewer: false,
  }
  const listeners = new Map<string, EventListener>()
  const scrollWrites: number[] = []
  let rows: HTMLElement[] = []
  const setRows = (positions: { id?: string; boundary?: boolean; top: number; height?: number }[]) => {
    rows = positions.map(({ id, boundary, top, height = 80 }) => {
      const row = document.createElement("div")
      if (id) row.dataset.msgId = id
      if (boundary) row.dataset.newDivider = ""
      row.getBoundingClientRect = () => DOMRect.fromRect({ y: top, height })
      return row
    })
  }
  let clientHeight = initialClientHeight
  let scrollHeight = initialScrollHeight
  let scrollTop = Math.max(0, scrollHeight - clientHeight - distanceToEnd)
  const scroller = {
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: vi.fn(),
    closest: () => ({ querySelector: () => ({}) }),
    querySelectorAll: () => rows.filter((row) => row.dataset.msgId !== undefined),
    querySelector: () => rows.find((row) => row.hasAttribute("data-new-divider")) ?? null,
    getBoundingClientRect: () => ({ top: 0, bottom: clientHeight }),
    get clientHeight() {
      return clientHeight
    },
    get scrollHeight() {
      return scrollHeight
    },
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(value: number) {
      scrollTop = value
      scrollWrites.push(value)
    },
  } as unknown as HTMLDivElement
  virtualizer.scrollToEnd.mockImplementation(() => {
    scrollTop = Math.max(0, scrollHeight - clientHeight)
  })
  virtualizer.scrollToOffset.mockImplementation((offset: number) => { scrollTop = offset })

  let result!: ReturnType<typeof useScrollAnchor>
  function Probe() {
    const current = useScrollAnchor(hookInput)
    useLayoutEffect(() => { result = current })
    return createElement("div", { ref: (node: HTMLDivElement | null) => { current.scrollRef.current = node ? scroller : null } })
  }
  const view = render(createElement(Probe))
  const rerender = (overrides: Partial<typeof hookInput>) => {
    Object.assign(hookInput, overrides)
    act(() => view.rerender(createElement(Probe)))
    return result
  }

  const setBrowserScrollTop = (value: number) => {
    scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight))
  }
  const setScrollHeight = (value: number) => {
    scrollHeight = value
    setBrowserScrollTop(scrollTop)
  }
  const setClientHeight = (value: number) => {
    clientHeight = value
    // Browser max-scroll clamping is not a JavaScript policy write.
    setBrowserScrollTop(scrollTop)
  }
  const dispatchScroll = () => listeners.get("scroll")?.(new Event("scroll"))
  const dispatchResize = () => resizeCallbacks.at(-1)?.([], {} as ResizeObserver)
  const dispatchMutation = () => mutationCallbacks.at(-1)?.([], {} as MutationObserver)
  const resizeViewport = (
    nextClientHeight: number,
    order: "scroll-ro" | "ro-scroll" = "ro-scroll",
  ) => {
    setClientHeight(nextClientHeight)
    if (order === "scroll-ro") {
      dispatchScroll()
      dispatchResize()
    } else {
      dispatchResize()
      dispatchScroll()
    }
  }
  const geometry = () => ({ clientHeight, scrollHeight, scrollTop })

  return {
    listeners,
    scrollWrites,
    setRows,
    scroller,
    result,
    dispatchScroll,
    dispatchMutation,
    resizeViewport,
    setBrowserScrollTop,
    setClientHeight,
    setScrollHeight,
    geometry,
    rerender,
    unmount: view.unmount,
  }
}

function messageItem(id: string, authorId?: string): FlatItem {
  return {
    kind: "message",
    m: { id, type: "chat", grouped: false, authorId },
    key: `msg:${id}`,
  }
}

function growingRow(requestFrame: (callback: FrameRequestCallback) => void, index = 0) {
  let height = 400
  return {
    element: {
      dataset: { index: String(index) },
      getBoundingClientRect: () => ({ height }),
      get scrollHeight() {
        return height
      },
      isConnected: true,
      ownerDocument: {
        defaultView: {
          requestAnimationFrame: (callback: FrameRequestCallback) => {
            requestFrame(callback)
            return 1
          },
        },
      },
    } as unknown as Element,
    growTo: (nextHeight: number) => { height = nextHeight },
  }
}

beforeEach(resetHarness)
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe("useScrollAnchor delayed row-growth re-pin", () => {
  it("puts the fixed rail clearance inside the virtual total", async () => {
    await mountHook({ tailPaddingEnd: 40 })
    expect(virtualizerOptions?.paddingEnd).toBe(40)
  })

  it("cancels a pending older-page frame from the unmount fallback", async () => {
    stubWindow({ requestAnimationFrame: vi.fn(() => 42), cancelAnimationFrame: vi.fn() })
    const mounted = await mountHook({ items: [messageItem("m1")] })
    vi.spyOn(mounted.scroller, "querySelectorAll").mockReturnValue([{ dataset: { msgId: "m1" }, getBoundingClientRect: () => ({ top: 20, bottom: 40 }) }] as never)
    act(() => mounted.result.captureOlderPageAnchor())
    mounted.rerender({ isFetchingOlder: true })
    const current = mounted.rerender({ isFetchingOlder: false })
    expect(current.isOlderPageAnchorSettling).toBe(true)
    mounted.unmount()
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

  it("publishes warm-tail usability without waiting for the read snapshot", async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    const cancelFrame = vi.fn()
    const settled = vi.fn()
    stubWindow({
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        frameCallbacks.push(callback)
        return frameCallbacks.length
      },
      cancelAnimationFrame: cancelFrame,
    })

    const mounted = await mountHook({
      items: [messageItem("m1")],
      initialScrollReady: false,
      heroMeasured: true,
      onInitialPositionSettled: settled,
    })
    expect(virtualizer.scrollToEnd).toHaveBeenCalledOnce()
    expect(frameCallbacks).toHaveLength(1)
    frameCallbacks[0](0)
    expect(settled).toHaveBeenCalledOnce()

    mounted.rerender({
      initialScrollReady: true,
      newDividerBefore: "m1",
    })
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    expect(frameCallbacks).toHaveLength(1)
    expect(settled).toHaveBeenCalledOnce()

    frameCallbacks[0](0)
    expect(settled).toHaveBeenCalledOnce()
    mounted.rerender({ newDividerBefore: undefined })
    expect(frameCallbacks).toHaveLength(1)
    expect(settled).toHaveBeenCalledOnce()
  })

  it("measures live growth and re-pins after the direct-DOM size write settles", async () => {
    const { scrollWrites } = await mountHook()
    let frame: FrameRequestCallback | undefined
    const row = growingRow((callback) => { frame = callback })
    const measure = virtualizerOptions?.measureElement
    expect(measure).toBeTypeOf("function")

    expect(measure!(row.element, undefined, virtualizer as never)).toBe(400)
    row.growTo(930.4)
    expect(measure!(row.element, undefined, virtualizer as never)).toBe(931)
    expect(scrollWrites).toEqual([])

    await Promise.resolve()
    expect(scrollWrites).toEqual([1_600])
    expect(frame).toBeTypeOf("function")

    frame!(0)
    expect(scrollWrites).toEqual([1_600, 1_600])
  })

  it("settles a pinned tail after an appended row's first real measurement", async () => {
    const settleFrames: FrameRequestCallback[] = []
    stubWindow({
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        settleFrames.push(callback)
        return settleFrames.length
      },
      cancelAnimationFrame: vi.fn(),
    })
    const mounted = await mountHook({
      items: [messageItem("m1")],
      initialScrollReady: true,
      heroMeasured: true,
    })
    expect(settleFrames).toHaveLength(1)
    settleFrames[0](0)
    mounted.rerender({ items: [messageItem("m1"), messageItem("m2")] })

    let frame: FrameRequestCallback | undefined
    const row = growingRow((callback) => { frame = callback }, 1)
    const measure = virtualizerOptions?.measureElement

    expect(measure!(row.element, undefined, virtualizer as never)).toBe(400)
    expect(mounted.scrollWrites).toEqual([])

    await Promise.resolve()
    expect(mounted.scrollWrites).toEqual([1_600])
    expect(frame).toBeTypeOf("function")

    frame!(0)
    expect(mounted.scrollWrites).toEqual([1_600, 1_600])
  })

  it("does not treat an anchored mount row as an append before initial positioning settles", async () => {
    const settleFrames: FrameRequestCallback[] = []
    stubWindow({
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        settleFrames.push(callback)
        return settleFrames.length
      },
      cancelAnimationFrame: vi.fn(),
    })
    const mounted = await mountHook({
      items: [messageItem("anchor"), messageItem("newer")],
      initialScrollReady: true,
      heroMeasured: true,
      newDividerBefore: "anchor",
    })
    let frame: FrameRequestCallback | undefined
    const row = growingRow((callback) => { frame = callback }, 1)
    const measure = virtualizerOptions?.measureElement

    expect(settleFrames).toHaveLength(1)
    expect(measure!(row.element, undefined, virtualizer as never)).toBe(400)
    await Promise.resolve()

    expect(mounted.scrollWrites).toEqual([])
    expect(frame).toBeUndefined()
  })

  it("does not schedule a re-pin after upward user intent", async () => {
    const { listeners, scrollWrites } = await mountHook()
    let frame: FrameRequestCallback | undefined
    const row = growingRow((callback) => { frame = callback })
    const measure = virtualizerOptions?.measureElement

    listeners.get("wheel")?.({ deltaY: -1 } as WheelEvent)
    expect(measure!(row.element, undefined, virtualizer as never)).toBe(400)
    row.growTo(780)
    expect(measure!(row.element, undefined, virtualizer as never)).toBe(780)
    await Promise.resolve()

    expect(scrollWrites).toEqual([])
    expect(frame).toBeUndefined()
  })

  it("switches live resize anchoring with scroll and keyboard intent", async () => {
    const { listeners, scroller } = await mountHook()
    expect(virtualizer.options.anchorTo).toBe("end")

    virtualizer.isAtEnd.mockReturnValue(false)
    scroller.scrollTop = 40
    listeners.get("scroll")?.(new Event("scroll"))
    expect(virtualizer.options.anchorTo).toBe("start")

    const adjust = virtualizer.shouldAdjustScrollPositionOnItemSizeChange
    expect(adjust).toBeTypeOf("function")
    expect(adjust!(
      { key: "unmeasured", start: 0, end: 20 } as never,
      20,
      {
        itemSizeCache: new Map(),
        scrollAdjustments: 0,
        scrollDirection: null,
        scrollOffset: 40,
      } as never,
    )).toBe(false)

    virtualizer.isAtEnd.mockReturnValue(true)
    listeners.get("scroll")?.(new Event("scroll"))
    expect(virtualizer.options.anchorTo).toBe("start")

    scroller.scrollTop = scroller.scrollHeight
    listeners.get("scroll")?.(new Event("scroll"))
    expect(virtualizer.options.anchorTo).toBe("end")

    listeners.get("keydown")?.({ key: "PageUp" } as KeyboardEvent)
    expect(virtualizer.options.anchorTo).toBe("start")
  })
})

const VIEWPORT_RESIZE_BOUNDARIES = [0, 1, 2, 99, 100, 101, 300]

describe("useScrollAnchor semantic viewport resize anchoring", () => {
  it("ignores a ResizeObserver delivery when the viewport height is unchanged", async () => {
    const mounted = await mountHook({ distanceToEnd: 2 })
    const before = mounted.geometry()

    mounted.resizeViewport(before.clientHeight)

    expect(mounted.geometry()).toEqual(before)
    expect(mounted.scrollWrites).toEqual([])
  })

  it.each(VIEWPORT_RESIZE_BOUNDARIES)(
    "resolves a composer growth from an initial %ipx tail distance",
    async (distanceToEnd) => {
      const { geometry, resizeViewport } = await mountHook({ distanceToEnd })

      resizeViewport(799)

      const expectedScrollTop = distanceToEnd <= 100
        ? 1_600 - 799 - distanceToEnd
        : 1_600 - 800 - distanceToEnd
      expect(geometry()).toEqual({
        clientHeight: 799,
        scrollHeight: 1_600,
        scrollTop: expectedScrollTop,
      })
      expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    },
  )

  it.each(VIEWPORT_RESIZE_BOUNDARIES)(
    "resolves a composer shrink from an initial %ipx tail distance",
    async (distanceToEnd) => {
      const { geometry, resizeViewport } = await mountHook({ distanceToEnd })

      resizeViewport(801)

      const expectedScrollTop = distanceToEnd <= 100
        ? 1_600 - 801 - distanceToEnd
        : 1_600 - 800 - distanceToEnd
      expect(geometry()).toEqual({
        clientHeight: 801,
        scrollHeight: 1_600,
        scrollTop: expectedScrollTop,
      })
      expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    },
  )

  it("preserves tail distance regardless of scroll/resize callback ordering", async () => {
    for (const order of ["scroll-ro", "ro-scroll"] as const) {
      const mounted = await mountHook({ distanceToEnd: 2 })

      mounted.resizeViewport(803, order)

      const { clientHeight, scrollHeight, scrollTop } = mounted.geometry()
      expect(scrollHeight - clientHeight - scrollTop).toBe(2)
      resetHarness()
    }
  })

  it("repairs browser shrink clamping in the footer-mutation microtask before ResizeObserver", async () => {
    const mounted = await mountHook({ distanceToEnd: 100 })

    mounted.setClientHeight(920)
    expect(mounted.geometry().scrollHeight - mounted.geometry().clientHeight - mounted.geometry().scrollTop)
      .toBe(0)
    mounted.dispatchMutation()

    expect(mounted.geometry().scrollHeight - mounted.geometry().clientHeight - mounted.geometry().scrollTop)
      .toBe(100)
    mounted.resizeViewport(920)
    expect(mounted.geometry().scrollHeight - mounted.geometry().clientHeight - mounted.geometry().scrollTop)
      .toBe(100)
  })

  it.each([
    { name: "grow→grow", heights: [780, 760] },
    { name: "shrink→shrink", heights: [801, 802] },
    { name: "grow→shrink", heights: [780, 800] },
  ])("preserves a 2px tail distance across rapid $name sequences", async ({ heights }) => {
    const { geometry, resizeViewport } = await mountHook({ distanceToEnd: 2 })

    for (const height of heights) resizeViewport(height)

    const { clientHeight, scrollHeight, scrollTop } = geometry()
    expect(scrollHeight - clientHeight - scrollTop).toBe(2)
  })

  it("preserves a 300px reading scrollTop across rapid growth and shrink", async () => {
    const { geometry, resizeViewport } = await mountHook({ distanceToEnd: 300 })
    const initialScrollTop = geometry().scrollTop

    resizeViewport(780)
    resizeViewport(760)
    resizeViewport(800)

    expect(geometry().scrollTop).toBe(initialScrollTop)
  })

  it("lets the existing explicit end action restore the latch", async () => {
    const { dispatchScroll, geometry, resizeViewport, result } = await mountHook({
      distanceToEnd: 300,
    })

    result.scrollToBottom()
    dispatchScroll()
    virtualizer.scrollToEnd.mockClear()
    resizeViewport(799)

    expect(geometry().scrollHeight - geometry().clientHeight - geometry().scrollTop).toBe(0)
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("restores the latch for warm-mount and peer-follow end actions", async () => {
    const first = messageItem("m1", "peer")
    const { geometry, rerender, resizeViewport } = await mountHook({
      distanceToEnd: 2,
      items: [first],
      heroMeasured: true,
    })

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(virtualizer.options.anchorTo).toBe("end")

    virtualizer.scrollToEnd.mockClear()
    rerender({
      items: [first, messageItem("m2", "peer")],
      viewerUserId: "viewer",
    })
    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(virtualizer.options.anchorTo).toBe("end")

    virtualizer.scrollToEnd.mockClear()
    resizeViewport(799)
    expect(geometry().scrollHeight - geometry().clientHeight - geometry().scrollTop).toBe(0)
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("restores the latch for an explicit present action", async () => {
    const { geometry, resizeViewport, result, rerender, dispatchScroll } = await mountHook({
      distanceToEnd: 300,
      items: [messageItem("m1")],
      presentVersion: 0,
    })
    act(() => result.requestPresentPosition())
    rerender({ presentVersion: 1 })
    dispatchScroll()

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(virtualizer.options.anchorTo).toBe("end")

    virtualizer.scrollToEnd.mockClear()
    resizeViewport(799)
    expect(geometry().scrollHeight - geometry().clientHeight - geometry().scrollTop).toBe(0)
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("re-pins an exactly pinned image load but ignores one after upward intent", async () => {
    const { listeners, result } = await mountHook({ distanceToEnd: 0 })

    virtualizer.options.anchorTo = "start"
    result.onImageLoad()
    expect(virtualizer.options.anchorTo).toBe("end")
    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)

    virtualizer.scrollToEnd.mockClear()
    listeners.get("wheel")?.({ deltaY: -1 } as WheelEvent)
    result.onImageLoad()
    expect(virtualizer.options.anchorTo).toBe("start")
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("uses exact-pinned rather than 100px near-bottom for delayed row growth", async () => {
    const { scrollWrites } = await mountHook({ distanceToEnd: 99 })
    const row = growingRow(() => {})
    const measure = virtualizerOptions?.measureElement

    expect(measure!(row.element, undefined, virtualizer as never)).toBe(400)
    row.growTo(500)
    expect(measure!(row.element, undefined, virtualizer as never)).toBe(500)
    await Promise.resolve()

    expect(scrollWrites).toEqual([])
  })
})


describe("message positioning owner", () => {
  function captureFrames() {
    const frames: FrameRequestCallback[] = []
    stubWindow({ requestAnimationFrame: (frame) => { frames.push(frame); return frames.length }, cancelAnimationFrame: vi.fn() })
    return frames
  }

  it("settles initial unread positioning only after its own NEW boundary and actual message stay visible", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [{ kind: "new-divider", key: "new-divider" }, messageItem("unread")],
      heroMeasured: true, initialScrollReady: true, newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    expect(settled).not.toHaveBeenCalled()
    mounted.setRows([{ boundary: true, top: 390, height: 20 }])
    act(() => frames.shift()?.(0))
    expect(settled).not.toHaveBeenCalled()
    mounted.setRows([{ boundary: true, top: 390, height: 20 }, { id: "unread", top: 420 }])
    act(() => frames.shift()?.(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(0, { align: "center" })
    expect(virtualizer.scrollToOffset).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it("corrects measured initial unread drift before revealing instead of accepting the first stable frame", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ distanceToEnd: 400, items: [{ kind: "new-divider", key: "new-divider" }, messageItem("unread")],
      heroMeasured: true, initialScrollReady: true, newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    mounted.setRows([{ boundary: true, top: 390, height: 20 }, { id: "unread", top: 420 }])
    act(() => frames.shift()?.(0))
    mounted.setRows([{ boundary: true, top: 490, height: 20 }, { id: "unread", top: 520 }])
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(500, { behavior: "auto" })
    expect(settled).not.toHaveBeenCalled()
    mounted.setRows([{ boundary: true, top: 390, height: 20 }, { id: "unread", top: 420 }])
    act(() => frames.shift()?.(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it("retargets the native initial unread index only when the current layout or estimate changes", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("unread")], heroMeasured: true, initialScrollReady: true,
      newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    virtualizer.getTotalSize.mockReturnValue(1_700)
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(2)
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(2)
    mounted.rerender({ items: [messageItem("older"), messageItem("unread")] })
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "center", behavior: "auto" })
    mounted.setRows([{ id: "unread", top: 360 }])
    act(() => frames.shift()?.(0))
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it.each([{ distanceToEnd: 800, top: 20 }, { distanceToEnd: 0, top: 700 }])(
    "accepts a visible unread boundary at the browser edge clamp instead of waiting for impossible centering ($top)",
    async ({ distanceToEnd, top }) => {
      const frames = captureFrames()
      const settled = vi.fn()
      const mounted = await mountHook({ distanceToEnd, items: [messageItem("unread")], heroMeasured: true,
        initialScrollReady: true, newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
      mounted.setRows([{ id: "unread", top }])
      act(() => frames.shift()?.(0))
      expect(settled).not.toHaveBeenCalled()
      act(() => frames.shift()?.(0))
      expect(settled).toHaveBeenCalledOnce()
      expect(virtualizer.scrollToOffset).not.toHaveBeenCalled()
      mounted.unmount()
    },
  )

  it("retires delayed initial unread correction on wheel and reveals without a later native write", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("unread")], heroMeasured: true, initialScrollReady: true,
      newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    const oldPoll = frames.shift()!
    act(() => mounted.listeners.get("wheel")?.(new WheelEvent("wheel", { deltaY: -80 })))
    const writes = virtualizer.scrollToOffset.mock.calls.length
    mounted.setRows([{ id: "unread", top: 900 }])
    act(() => oldPoll(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(writes)
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it("gives a replacement explicit target precedence over an unresolved initial unread boundary", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("unread"), messageItem("target")], heroMeasured: true,
      initialScrollReady: true, newDividerBefore: "unread", hasMoreNewer: true,
      onInitialPositionSettled: settled, onScrollTargetPositioned: positioned })
    act(() => frames.shift()?.(0))
    const oldPoll = frames.shift()!
    mounted.rerender({ scrollToMessageId: "target" })
    const writes = virtualizer.scrollToOffset.mock.calls.length
    mounted.setRows([{ id: "unread", top: 900 }, { id: "target", top: 160 }])
    act(() => oldPoll(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(writes)
    act(() => frames.shift()?.(0))
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledExactlyOnceWith("target")
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
  })

  it("keeps the original unread deadline when pagination takes over its unresolved geometry", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("anchor"), messageItem("unread")], heroMeasured: true,
      initialScrollReady: true, newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    const oldPoll = frames.shift()!
    act(() => vi.advanceTimersByTime(1_800))
    mounted.setRows([{ id: "anchor", top: 120 }])
    act(() => mounted.result.captureOlderPageAnchor())
    mounted.rerender({ isFetchingOlder: true })
    const writes = virtualizer.scrollToOffset.mock.calls.length
    mounted.setRows([{ id: "unread", top: 900 }])
    act(() => oldPoll(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(writes)
    act(() => vi.advanceTimersByTime(200))
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds unresolved initial unread geometry and never corrects a row arriving after expiry", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("unread")], heroMeasured: true, initialScrollReady: true,
      newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    const oldPoll = frames.shift()!
    act(() => vi.advanceTimersByTime(1_999))
    expect(settled).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(settled).toHaveBeenCalledOnce()
    const writes = virtualizer.scrollToOffset.mock.calls.length
    mounted.setRows([{ id: "unread", top: 900 }])
    act(() => oldPoll(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(writes)
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retires initial unread geometry and its timer on unmount", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("unread")], heroMeasured: true, initialScrollReady: true,
      newDividerBefore: "unread", hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    const oldPoll = frames.shift()!
    mounted.unmount()
    const writes = virtualizer.scrollToOffset.mock.calls.length
    act(() => oldPoll(0))
    expect(virtualizer.scrollToOffset).toHaveBeenCalledTimes(writes)
    expect(settled).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("releases an unavailable initial anchor after two seconds and never revives it on a late snapshot", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], hasMoreNewer: true, onInitialPositionSettled: settled })
    act(() => vi.advanceTimersByTime(2_000))
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    mounted.rerender({ heroMeasured: true, initialScrollReady: true, newDividerBefore: "m1" })
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("gives an explicit target the first write and discards the old initial settlement frame", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1"), messageItem("m2")], heroMeasured: true, onInitialPositionSettled: settled, onScrollTargetPositioned: positioned })
    const oldInitialFrame = frames.shift()!
    virtualizer.scrollToEnd.mockClear()
    mounted.rerender({ scrollToMessageId: "m2", initialScrollReady: true, newDividerBefore: "m1" })
    mounted.setRows([{ id: "m2", top: 160 }])
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: "center", behavior: "auto" })
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    act(() => oldInitialFrame(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledExactlyOnceWith("m2")
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
  })

  it("fences a target callback when a newer target owns the session", async () => {
    const frames = captureFrames()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1"), messageItem("m2")], heroMeasured: true, scrollToMessageId: "m1", onScrollTargetPositioned: positioned })
    const oldTarget = frames.shift()!
    mounted.rerender({ scrollToMessageId: "m2" })
    mounted.setRows([{ id: "m2", top: 160 }])
    act(() => oldTarget(0))
    expect(positioned).not.toHaveBeenCalled()
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledExactlyOnceWith("m2")
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("retires a pending target on user wheel input and does not revive it when rows arrive", async () => {
    const frames = captureFrames()
    const positioned = vi.fn()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "m2", onScrollTargetPositioned: positioned, onInitialPositionSettled: settled })
    act(() => mounted.listeners.get("wheel")?.(new WheelEvent("wheel", { deltaY: -60 })))
    mounted.rerender({ items: [messageItem("m1"), messageItem("m2")], initialScrollReady: true, newDividerBefore: "m1" })
    act(() => frames.shift()?.(0))
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    expect(positioned).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledOnce()
  })

  it("waits for the actual target row to enter the viewport before consuming its native request", async () => {
    const frames = captureFrames()
    const positioned = vi.fn()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "m1", onScrollTargetPositioned: positioned, onInitialPositionSettled: settled })
    act(() => frames.shift()?.(0))
    expect(positioned).not.toHaveBeenCalled()
    mounted.setRows([{ id: "m1", top: 900 }])
    act(() => frames.shift()?.(0))
    expect(positioned).not.toHaveBeenCalled()
    act(() => mounted.result.captureOlderPageAnchor())
    expect(mounted.result.isOlderPageAnchorSettling).toBe(false)
    mounted.setRows([{ id: "m1", top: 160 }])
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledExactlyOnceWith("m1")
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
  })

  it("keeps the original first-display deadline when pagination takes a pending reveal", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, onInitialPositionSettled: settled })
    const retiredReveal = frames.shift()!
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => vi.advanceTimersByTime(1_800))
    act(() => mounted.result.captureOlderPageAnchor())
    mounted.rerender({ isFetchingOlder: true })
    act(() => retiredReveal(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(199))
    expect(settled).not.toHaveBeenCalled()
    const writes = [...mounted.scrollWrites]
    act(() => vi.advanceTimersByTime(1))
    expect(settled).toHaveBeenCalledOnce()
    expect(mounted.scrollWrites).toEqual(writes)
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retains the first-display deadline after target geometry completes and pagination cancels its reveal", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "m1", onInitialPositionSettled: settled, onScrollTargetPositioned: positioned })
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledOnce()
    const retiredReveal = frames.shift()!
    act(() => mounted.result.captureOlderPageAnchor())
    act(() => retiredReveal(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(2_000))
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds native target geometry waiting and discards its late mounted row", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "m1", onInitialPositionSettled: settled, onScrollTargetPositioned: positioned })
    mounted.setRows([{ id: "m1", top: 900 }])
    act(() => frames.shift()?.(0))
    const retiredPoll = frames.shift()!
    act(() => vi.advanceTimersByTime(2_000))
    expect(settled).toHaveBeenCalledOnce()
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => retiredPoll(0))
    expect(positioned).not.toHaveBeenCalled()
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("settles the first display when older pagination completes before the original reveal", async () => {
    const frames = captureFrames()
    const settled = vi.fn()
    const initial = [messageItem("m1")]
    const mounted = await mountHook({ items: initial, heroMeasured: true, onInitialPositionSettled: settled })
    const retiredReveal = frames.shift()!
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => mounted.result.captureOlderPageAnchor())
    mounted.rerender({ isFetchingOlder: true })
    mounted.rerender({ items: [messageItem("older"), ...initial], isFetchingOlder: false })
    act(() => retiredReveal(0))
    expect(settled).not.toHaveBeenCalled()
    act(() => { while (frames.length) frames.shift()!(0) })
    expect(settled).toHaveBeenCalledOnce()
    expect(mounted.rerender({}).isOlderPageAnchorSettling).toBe(false)
    mounted.unmount()
  })

  it("bounds first-display waiting when a pagination fetching render was never observed", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const initial = [messageItem("m1")]
    const mounted = await mountHook({ items: initial, heroMeasured: true, onInitialPositionSettled: settled })
    const retiredReveal = frames.shift()!
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => mounted.result.captureOlderPageAnchor())
    mounted.rerender({ items: [messageItem("older"), ...initial], isFetchingOlder: false })
    act(() => retiredReveal(0))
    expect(settled).not.toHaveBeenCalled()
    virtualizer.scrollToIndex.mockClear()
    act(() => vi.advanceTimersByTime(2_000))
    expect(settled).toHaveBeenCalledOnce()
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not let an old deadline or delayed target frame expire a newer target", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1"), messageItem("m2")], heroMeasured: true, scrollToMessageId: "m1", onInitialPositionSettled: settled, onScrollTargetPositioned: positioned })
    const retiredTarget = frames.shift()!
    act(() => vi.advanceTimersByTime(1_800))
    mounted.rerender({ scrollToMessageId: "m2" })
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => retiredTarget(0))
    act(() => vi.advanceTimersByTime(200))
    expect(settled).not.toHaveBeenCalled()
    expect(positioned).not.toHaveBeenCalled()
    mounted.setRows([{ id: "m2", top: 120 }])
    act(() => frames.shift()?.(0))
    act(() => frames.shift()?.(0))
    expect(positioned).toHaveBeenCalledExactlyOnceWith("m2")
    expect(settled).toHaveBeenCalledOnce()
    mounted.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retires target geometry polling on wheel without a late callback or scroll", async () => {
    const frames = captureFrames()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "m1", onScrollTargetPositioned: positioned })
    act(() => frames.shift()?.(0))
    const retiredPoll = frames.shift()!
    act(() => mounted.listeners.get("wheel")?.(new WheelEvent("wheel", { deltaY: -60 })))
    const nativeWrites = virtualizer.scrollToIndex.mock.calls.length
    mounted.setRows([{ id: "m1", top: 120 }])
    act(() => retiredPoll(0))
    expect(positioned).not.toHaveBeenCalled()
    expect(virtualizer.scrollToIndex).toHaveBeenCalledTimes(nativeWrites)
    mounted.unmount()
  })

  it("bounds a target missing from a readable window without a late target yank", async () => {
    vi.useFakeTimers()
    const frames = captureFrames()
    const settled = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true, scrollToMessageId: "missing", onInitialPositionSettled: settled })
    act(() => vi.advanceTimersByTime(2_000))
    act(() => frames.shift()?.(0))
    expect(settled).toHaveBeenCalledOnce()
    mounted.rerender({ items: [messageItem("m1"), messageItem("missing")] })
    expect(virtualizer.scrollToIndex).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it("suppresses a queued resize re-pin after an explicit target replaces it", async () => {
    const mounted = await mountHook({ items: [messageItem("m1"), messageItem("m2")] })
    let lateRepin!: FrameRequestCallback
    const row = growingRow((frame) => { lateRepin = frame })
    virtualizerOptions!.measureElement!(row.element, undefined, virtualizer as never)
    row.growTo(900)
    virtualizerOptions!.measureElement!(row.element, undefined, virtualizer as never)
    await Promise.resolve()
    const before = [...mounted.scrollWrites]
    mounted.rerender({ scrollToMessageId: "m2", heroMeasured: true })
    lateRepin(0)
    expect(mounted.scrollWrites).toEqual(before)
    expect(virtualizer.scrollToIndex).toHaveBeenCalledExactlyOnceWith(1, { align: "center", behavior: "auto" })
  })

  it("ignores target settlement and queued repins after the conversation unmounts", async () => {
    const frames = captureFrames()
    const positioned = vi.fn()
    const mounted = await mountHook({ items: [messageItem("m1")], scrollToMessageId: "m1", heroMeasured: true, onScrollTargetPositioned: positioned })
    mounted.unmount()
    act(() => { for (const frame of frames) frame(0) })
    expect(positioned).not.toHaveBeenCalled()
  })

  it.each(["wheel", "target"])("keeps a late present completion retired after %s supersedes its intent", async (intent) => {
    const mounted = await mountHook({
      distanceToEnd: 300,
      items: [messageItem("m1"), messageItem("m2")],
      initialScrollReady: true,
      heroMeasured: true,
      hasMoreNewer: true,
      presentVersion: 0,
    })
    act(() => mounted.result.requestPresentPosition())
    if (intent === "wheel") act(() => mounted.listeners.get("wheel")?.({ deltaY: -40 } as WheelEvent))
    else mounted.rerender({ scrollToMessageId: "m1" })
    virtualizer.scrollToEnd.mockClear()
    const before = mounted.geometry().scrollTop
    mounted.rerender({ presentVersion: 1, hasMoreNewer: false })
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    expect(mounted.geometry().scrollTop).toBe(before)
    expect(virtualizer.options.anchorTo).toBe("start")
    mounted.rerender({ items: [messageItem("m1"), messageItem("m2")], presentVersion: 1 })
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("retires a native index request immediately when an unloaded target or pending present takes ownership", async () => {
    const mounted = await mountHook({ items: [messageItem("m1")], heroMeasured: true })
    act(() => mounted.result.jumpTo("m1", "smooth"))
    virtualizer.scrollToOffset.mockClear()
    mounted.rerender({ scrollToMessageId: "not-loaded" })
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(mounted.geometry().scrollTop, { behavior: "auto" })
    virtualizer.scrollToOffset.mockClear()
    act(() => mounted.result.requestPresentPosition())
    expect(virtualizer.scrollToOffset).toHaveBeenCalledExactlyOnceWith(mounted.geometry().scrollTop, { behavior: "auto" })
  })

  it("accepts a canceled present window's historical self tail without following it when a late divider lands, then follows a genuine send", async () => {
    const mounted = await mountHook({
      distanceToEnd: 300,
      items: [messageItem("old-window", "peer")],
      initialScrollReady: true,
      heroMeasured: true,
      hasMoreNewer: true,
      viewerUserId: "viewer",
      presentVersion: 0,
    })
    act(() => mounted.result.requestPresentPosition())
    act(() => mounted.listeners.get("wheel")?.({ deltaY: -40 } as WheelEvent))
    const newestWindow = [messageItem("old-window", "peer"), messageItem("historical-self", "viewer")]
    virtualizer.scrollToEnd.mockClear()
    mounted.rerender({ items: newestWindow, presentVersion: 1, hasMoreNewer: false })
    mounted.rerender({ items: [...newestWindow], newDividerBefore: "historical-self" })
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    mounted.rerender({ items: [...newestWindow, messageItem("new-send", "viewer")] })
    expect(virtualizer.scrollToEnd).toHaveBeenCalledOnce()
  })

  it("accepts a newer page arriving before its replacement target settles without following its historical self tail", async () => {
    const frames = captureFrames()
    const mounted = await mountHook({ distanceToEnd: 300, items: [messageItem("old-window", "peer")], initialScrollReady: true, heroMeasured: true, hasMoreNewer: true, viewerUserId: "viewer" })
    act(() => mounted.result.captureNewerPageAnchor())
    mounted.rerender({ isFetchingNewer: true })
    act(() => mounted.result.jumpTo("old-window", "smooth"))
    const completed = [messageItem("old-window", "peer"), messageItem("historical-self", "viewer")]
    virtualizer.scrollToEnd.mockClear()
    mounted.rerender({ items: completed, isFetchingNewer: false, hasMoreNewer: false })
    act(() => { while (frames.length) frames.shift()!(0) })
    mounted.rerender({ items: [...completed], newDividerBefore: "historical-self" })
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    mounted.rerender({ items: [...completed, messageItem("new-send", "viewer")] })
    expect(virtualizer.scrollToEnd).toHaveBeenCalledOnce()
  })
})
