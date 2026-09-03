/**
 * The web unit suite runs without a browser DOM. Drive `useScrollAnchor`
 * through small React/TanStack shims so the row-measurement callback and its
 * deferred bottom re-pin contract stay covered without duplicating that logic
 * in a test-only export.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { VirtualizerOptions } from "@tanstack/react-virtual"
import type { FlatItem } from "@/lib/community/message-list-items"

let refs: Array<{ current: unknown }> = []
let refIndex = 0
let layoutEffects: Array<() => void | (() => void)> = []
let resizeCallbacks: ResizeObserverCallback[] = []

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
  hasMoreNewer,
  presentVersion,
  viewerUserId,
}: {
  distanceToEnd?: number
  initialClientHeight?: number
  initialScrollHeight?: number
  items?: FlatItem[]
  initialScrollReady?: boolean
  heroMeasured?: boolean
  hasMoreNewer?: boolean
  presentVersion?: number
  viewerUserId?: string
} = {}) {
  const { useScrollAnchor } = await import("./use-scroll-anchor")
  const hookInput = {
    items,
    initialScrollReady,
    heroHeight: 0,
    heroMeasured,
    hasMoreNewer,
    presentVersion,
    viewerUserId,
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

describe("useScrollAnchor delayed row-growth re-pin", () => {
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
    expect(adjust!({} as never, 20, {} as never)).toBe(false)

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

const EXACT_PIN_BOUNDARIES = [0, 1, 2, 99, 100, 101, 300]

describe("useScrollAnchor viewport resize exact-pinned latch", () => {
  it.each(EXACT_PIN_BOUNDARIES)(
    "uses the resize end writer only for an initial %ipx distance when the viewport grows",
    async (distanceToEnd) => {
      const { resizeViewport } = await mountHook({ distanceToEnd })

      resizeViewport(799)

      expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(distanceToEnd <= 1 ? 1 : 0)
    },
  )

  it.each(EXACT_PIN_BOUNDARIES)(
    "uses the resize end writer only for an initial %ipx distance when the viewport shrinks",
    async (distanceToEnd) => {
      const { resizeViewport } = await mountHook({ distanceToEnd })

      resizeViewport(801)

      expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(distanceToEnd <= 1 ? 1 : 0)
    },
  )

  it("promotes false only after a stable scroll moves toward the literal end", async () => {
    const { dispatchScroll, geometry, resizeViewport, setBrowserScrollTop } = await mountHook({
      distanceToEnd: 2,
    })

    setBrowserScrollTop(geometry().scrollHeight - geometry().clientHeight)
    dispatchScroll()
    resizeViewport(799)

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
  })

  it("does not promote false when content shrink reaches 1px at the same scrollTop", async () => {
    const { dispatchScroll, geometry, resizeViewport, setScrollHeight } = await mountHook({
      distanceToEnd: 2,
    })

    setScrollHeight(geometry().scrollHeight - 1)
    dispatchScroll()
    resizeViewport(799)

    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("clears exact-pinned immediately on existing upward wheel and keyboard intent", async () => {
    const wheel = await mountHook({ distanceToEnd: 0 })
    wheel.listeners.get("wheel")?.({ deltaY: -1 } as WheelEvent)
    wheel.resizeViewport(799)
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()

    resetHarness()
    const keyboard = await mountHook({ distanceToEnd: 0 })
    keyboard.listeners.get("keydown")?.({ key: "PageUp" } as KeyboardEvent)
    keyboard.resizeViewport(799)
    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it.each(["scroll-ro", "ro-scroll"] as const)(
    "keeps a clamped false latch false through a second resize for %s ordering",
    async (order) => {
      const { resizeViewport } = await mountHook({ distanceToEnd: 2 })

      // Growing the viewport by 3px clamps the browser scrollTop down to its
      // new max. Whether that scroll callback runs before or after RO, it must
      // not turn the original 2px-away latch true.
      resizeViewport(803, order)
      resizeViewport(799, "ro-scroll")

      expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
    },
  )

  it.each([
    { name: "grow→grow", heights: [780, 760] },
    { name: "shrink→shrink", heights: [801, 802] },
    { name: "grow→shrink", heights: [780, 800] },
  ])("preserves a false latch across rapid $name viewport sequences", async ({ heights }) => {
    const { resizeViewport } = await mountHook({ distanceToEnd: 2 })

    for (const height of heights) resizeViewport(height)

    expect(virtualizer.scrollToEnd).not.toHaveBeenCalled()
  })

  it("keeps an exact-pinned latch continuous across rapid grow and shrink", async () => {
    const { resizeViewport } = await mountHook({ distanceToEnd: 1 })

    resizeViewport(780)
    resizeViewport(760)
    resizeViewport(800)

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(3)
  })

  it("lets the existing explicit end action restore the latch", async () => {
    const { resizeViewport, result } = await mountHook({ distanceToEnd: 300 })

    result.scrollToBottom()
    virtualizer.scrollToEnd.mockClear()
    resizeViewport(799)

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
  })

  it("restores the latch for warm-mount and peer-follow end actions", async () => {
    const first = messageItem("m1", "peer")
    const { rerender, resizeViewport } = await mountHook({
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
    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
  })

  it("restores the latch for an explicit present action", async () => {
    const { resizeViewport } = await mountHook({
      distanceToEnd: 300,
      items: [messageItem("m1")],
      presentVersion: 1,
    })

    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(virtualizer.options.anchorTo).toBe("end")

    virtualizer.scrollToEnd.mockClear()
    resizeViewport(799)
    expect(virtualizer.scrollToEnd).toHaveBeenCalledTimes(1)
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
