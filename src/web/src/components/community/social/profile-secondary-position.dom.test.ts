import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  mockElementGeometry,
  render,
  renderHook,
  screen,
} from "@/test/react-dom-harness"
import {
  resolveAuditPreviewPlacement,
  useProfileSecondaryPosition,
} from "./profile-secondary-position"

type PositionState = ReturnType<typeof useProfileSecondaryPosition>

const animationFrames = new Map<number, FrameRequestCallback>()
const resizeObservers: TestResizeObserver[] = []
let nextAnimationFrame = 1

class TestResizeObserver {
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this)
  }
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height })
}

function PositionHarness({
  onRender,
  enabled = true,
  previewId = "preview",
  x = 0,
  y = 0,
}: {
  onRender: (state: PositionState) => void
  enabled?: boolean
  previewId?: string
  x?: number
  y?: number
}) {
  const state = useProfileSecondaryPosition(enabled, previewId, x, y)
  onRender(state)
  return createElement(
    "div",
    { ref: state.popoverRef, "data-testid": "popover" },
    createElement("div", { ref: state.cardRef, "data-testid": "card" }),
    createElement("div", { ref: state.previewRef, "data-testid": "preview" }),
  )
}

beforeEach(() => {
  animationFrames.clear()
  resizeObservers.length = 0
  nextAnimationFrame = 1
  setViewport(1000, 800)
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame++
    animationFrames.set(frame, callback)
    return frame
  }))
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frame: number) => {
    animationFrames.delete(frame)
  }))
  vi.stubGlobal("ResizeObserver", TestResizeObserver)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("resolveAuditPreviewPlacement", () => {
  it("uses the side with the most room when no placement fits", () => {
    expect(resolveAuditPreviewPlacement({
      card: {
        top: 20,
        right: 550,
        bottom: 100,
        left: 50,
        width: 500,
        height: 80,
      },
      preview: { width: 1000, height: 1000 },
      viewportWidth: 600,
      viewportHeight: 500,
    })).toBe("bottom")
  })

  it("defaults to the right if no room ranking is available", () => {
    const entries = vi.spyOn(Object, "entries").mockReturnValueOnce([])
    const placement = resolveAuditPreviewPlacement({
      card: { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 },
      preview: { width: 1000, height: 1000 },
      viewportWidth: 100,
      viewportHeight: 100,
    })
    entries.mockRestore()

    expect(placement).toBe("right")
  })
})

describe("useProfileSecondaryPosition", () => {
  it("stays unready when enabled before its refs exist", () => {
    const rendered = renderHook(() => useProfileSecondaryPosition(true, "preview", 12, 24))

    expect(rendered.result.current.ready).toBe(false)
    expect(rendered.result.current.position).toBeNull()
    expect(rendered.result.current.cardRef.current).toBeNull()
    expect(rendered.result.current.previewRef.current).toBeNull()
    expect(resizeObservers).toHaveLength(1)
    expect(resizeObservers[0]?.observe).not.toHaveBeenCalled()

    act(() => {
      animationFrames.get(1)?.(0)
    })
    expect(rendered.result.current.position).toBeNull()

    rendered.unmount()
    expect(resizeObservers[0]?.disconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  })

  it("clears a prior measurement when disabled and works without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined)
    const rendered = renderHook(
      ({ enabled, previewId }) => useProfileSecondaryPosition(enabled, previewId, 0, 0),
      { initialProps: { enabled: true, previewId: "preview" as string | undefined } },
    )

    expect(animationFrames).toHaveLength(1)
    rendered.rerender({ enabled: false, previewId: "preview" })
    expect(rendered.result.current.ready).toBe(false)
    expect(rendered.result.current.position).toBeNull()

    rendered.rerender({ enabled: true, previewId: undefined })
    expect(rendered.result.current.ready).toBe(false)
    expect(rendered.result.current.position).toBeNull()
  })

  it("measures every placement and reuses an identical observed position", () => {
    let latest: PositionState | undefined
    const rendered = render(createElement(PositionHarness, {
      onRender: (state) => {
        latest = state
      },
    }))
    const popover = screen.getByTestId("popover")
    const card = screen.getByTestId("card")
    const preview = screen.getByTestId("preview")
    const observer = resizeObservers[0]!

    expect(observer.observe).toHaveBeenNthCalledWith(1, card)
    expect(observer.observe).toHaveBeenNthCalledWith(2, preview)

    mockElementGeometry(card, { left: 100, top: 100, offsetWidth: 200, offsetHeight: 300 })
    mockElementGeometry(preview, { offsetWidth: 100, offsetHeight: 80 })
    act(() => window.dispatchEvent(new Event("resize")))
    expect(latest?.position).toEqual({
      measurementKey: "preview:0:0",
      placement: "right",
      left: 208,
      top: 0,
      height: 300,
    })

    const stablePosition = latest?.position
    act(() => observer.callback([], observer as unknown as ResizeObserver))
    expect(latest?.position).toBe(stablePosition)

    mockElementGeometry(card, { left: 700, top: 100, offsetWidth: 200, offsetHeight: 300 })
    act(() => popover.dispatchEvent(new Event("animationend")))
    expect(latest?.position).toMatchObject({ placement: "left", left: -108, top: 0 })

    mockElementGeometry(card, { left: 100, top: 300, offsetWidth: 200, offsetHeight: 200 })
    mockElementGeometry(preview, { offsetWidth: 800, offsetHeight: 100 })
    act(() => popover.dispatchEvent(new Event("animationcancel")))
    expect(latest?.position).toMatchObject({ placement: "top", left: -92, top: -108 })

    mockElementGeometry(card, { left: 100, top: 50, offsetWidth: 200, offsetHeight: 200 })
    act(() => window.dispatchEvent(new Event("scroll")))
    expect(latest?.position).toMatchObject({ placement: "bottom", left: -92, top: 208 })

    rendered.unmount()
    expect(observer.disconnect).toHaveBeenCalledOnce()
  })

  it("keeps unclamped offsets when the preview is larger than its viewport", () => {
    let latest: PositionState | undefined
    render(createElement(PositionHarness, { onRender: (state) => { latest = state } }))
    const card = screen.getByTestId("card")
    const preview = screen.getByTestId("preview")

    mockElementGeometry(card, { left: 400, top: 20, offsetWidth: 500, offsetHeight: 100 })
    mockElementGeometry(preview, { offsetWidth: 1200, offsetHeight: 900 })
    act(() => window.dispatchEvent(new Event("resize")))

    expect(latest?.position).toMatchObject({
      placement: "bottom",
      left: -700,
      top: 108,
    })

    mockElementGeometry(card, { left: 20, top: 20, offsetWidth: 100, offsetHeight: 100 })
    act(() => window.dispatchEvent(new Event("resize")))
    expect(latest?.position).toMatchObject({
      placement: "right",
      left: 108,
      top: 0,
    })
  })
})
