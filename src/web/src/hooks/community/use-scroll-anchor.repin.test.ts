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
  virtualizerOptions = undefined
  virtualizer.options.anchorTo = "end"
  virtualizer.isAtEnd.mockReturnValue(true)
  virtualizer.scrollToEnd.mockReset()
  virtualizer.scrollToIndex.mockReset()
}

async function mountHook() {
  const { useScrollAnchor } = await import("./use-scroll-anchor")
  // The React module is intentionally mocked above; this calls a deterministic
  // hook shim rather than mounting a real component tree.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const result = useScrollAnchor({
    items: [] as FlatItem[],
    initialScrollReady: false,
    heroHeight: 0,
    heroMeasured: false,
  })

  const listeners = new Map<string, EventListener>()
  const scrollWrites: number[] = []
  let scrollTop = 0
  const scroller = {
    scrollHeight: 1_600,
    clientHeight: 800,
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
    removeEventListener: vi.fn(),
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(value: number) {
      scrollTop = value
      scrollWrites.push(value)
    },
  } as unknown as HTMLDivElement
  result.scrollRef.current = scroller

  // The first layout effect installs the real scroll/wheel intent listeners.
  layoutEffects[0]?.()
  return { listeners, scrollWrites }
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
})
