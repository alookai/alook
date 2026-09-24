/**
 * The web unit suite runs without a browser DOM. Drive `useScrollAnchor`
 * through small React/TanStack shims so the row-measurement callback and its
 * deferred bottom re-pin contract stay covered without duplicating that logic
 * in a test-only export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { VirtualizerOptions } from "@tanstack/react-virtual"
import type { FlatItem } from "@/lib/community/message-list-items"

let refs: Array<{ current: unknown }> = []
let refIndex = 0
let layoutEffects: Array<() => void | (() => void)> = []
let resizeCallbacks: ResizeObserverCallback[] = []
const PAGINATION_ANCHOR_FRAME_REF_INDEX = 14
const PAGINATION_UNMOUNT_EFFECT_INDEX = 2

vi.mock("react", () => ({
  useRef: (initial: unknown) => {
    const index = refIndex++
    refs[index] ??= { current: initial }
    return refs[index]
  },
  useLayoutEffect: (effect: () => void | (() => void)) => {
    layoutEffects.push(effect)
  },
  useCallback: <T>(callback: T) => callback,
  useState: <T>(initial: T) => [initial, vi.fn()],
}))

const virtualizer = {
  options: { anchorTo: "end" },
  isAtEnd: vi.fn(() => true),
  scrollToEnd: vi.fn(),
  scrollToIndex: vi.fn(),
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
  refs = []
  refIndex = 0
  layoutEffects = []
  resizeCallbacks = []
  virtualizerOptions = undefined
  virtualizer.options.anchorTo = "end"
  virtualizer.isAtEnd.mockReturnValue(true)
  virtualizer.scrollToEnd.mockReset()
  virtualizer.scrollToIndex.mockReset()
  vi.stubGlobal("window", {
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
  }
  // The React module is intentionally mocked above; this calls a deterministic
  // hook shim rather than mounting a real component tree.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const result = useScrollAnchor(hookInput)

  const listeners = new Map<string, EventListener>()
  const scrollWrites: number[] = []
  let clientHeight = initialClientHeight
  let scrollHeight = initialScrollHeight
  let scrollTop = Math.max(0, scrollHeight - clientHeight - distanceToEnd)
  const scroller = {
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: vi.fn(),
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
  result.scrollRef.current = scroller
  virtualizer.scrollToEnd.mockImplementation(() => {
    scrollTop = Math.max(0, scrollHeight - clientHeight)
  })

  const runLayoutEffects = () => {
    for (const effect of layoutEffects) effect()
  }
  runLayoutEffects()

  const rerender = (overrides: Partial<typeof hookInput>) => {
    refIndex = 0
    layoutEffects = []
    Object.assign(hookInput, overrides)
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const nextResult = useScrollAnchor(hookInput)
    nextResult.scrollRef.current = scroller
    runLayoutEffects()
    return nextResult
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
    scroller,
    result,
    dispatchScroll,
    resizeViewport,
    setBrowserScrollTop,
    setScrollHeight,
    geometry,
    rerender,
  }
}

function messageItem(id: string, authorId?: string): FlatItem {
  return {
    kind: "message",
    m: { id, type: "chat", grouped: false, authorId },
    key: `msg:${id}`,
  }
}

function growingRow(requestFrame: (callback: FrameRequestCallback) => void) {
  let height = 400
  return {
    element: {
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
afterEach(() => vi.unstubAllGlobals())

describe("useScrollAnchor delayed row-growth re-pin", () => {
  it("cancels a pending older-page frame from the unmount fallback", async () => {
    await mountHook()
    const paginationAnchorFrameRef = refs[PAGINATION_ANCHOR_FRAME_REF_INDEX]
    paginationAnchorFrameRef.current = 42
    const cleanup = layoutEffects[PAGINATION_UNMOUNT_EFFECT_INDEX]()

    expect(cleanup).toBeTypeOf("function")
    cleanup!()
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(42)
  })

  it("publishes settlement one frame after the final initial convergence action", async () => {
    const frameCallbacks: FrameRequestCallback[] = []
    const cancelFrame = vi.fn()
    const settled = vi.fn()
    vi.stubGlobal("window", {
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
    expect(frameCallbacks).toHaveLength(0)
    expect(settled).not.toHaveBeenCalled()

    mounted.rerender({
      initialScrollReady: true,
      newDividerBefore: "m1",
    })
    expect(virtualizer.scrollToIndex).toHaveBeenCalledOnce()
    expect(frameCallbacks).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()

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
    const { geometry, resizeViewport } = await mountHook({
      distanceToEnd: 300,
      items: [messageItem("m1")],
      presentVersion: 1,
    })

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
