import { createElement, useLayoutEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen } from "@/test/react-dom-harness"
import type { FlatItem } from "@/lib/community/message-list-items"

const harness = vi.hoisted(() => ({
  absoluteTops: new Map<string, number>(),
  scroller: null as HTMLDivElement | null,
  scrollToIndex: vi.fn((index: number) => {
    if (!harness.scroller) return
    const row = harness.scroller.querySelector<HTMLElement>(`[data-index="${index}"]`)
    const id = row?.dataset.msgId
    if (id) harness.scroller.scrollTop = harness.absoluteTops.get(id) ?? 0
  }),
  virtualizer: {
    options: { anchorTo: "end" },
    isAtEnd: vi.fn(() => false),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    range: null,
    shouldAdjustScrollPositionOnItemSizeChange: undefined,
  },
}))

harness.virtualizer.scrollToIndex = harness.scrollToIndex

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => harness.virtualizer,
}))

import { useScrollAnchor } from "./use-scroll-anchor"

type AnchorResult = ReturnType<typeof useScrollAnchor>

function message(id: string): FlatItem {
  return {
    kind: "message",
    m: { id, type: "chat", grouped: false },
    key: `msg:${id}`,
  }
}

const day = (key: string): FlatItem => ({ kind: "date-divider", label: key, key: `date:${key}` })

function Harness({
  items,
  isFetchingOlder,
  isFetchingNewer = false,
  onResult,
}: {
  items: FlatItem[]
  isFetchingOlder: boolean
  isFetchingNewer?: boolean
  onResult: (result: AnchorResult) => void
}) {
  const result = useScrollAnchor({
    items,
    initialScrollReady: false,
    isFetchingOlder,
    isFetchingNewer,
    heroHeight: 0,
    heroMeasured: false,
  })
  useLayoutEffect(() => onResult(result), [onResult, result])
  return createElement(
    "div",
    { ref: result.scrollRef, "data-testid": "scroll" },
    ...items.map((item, index) => createElement("div", {
      key: item.key,
      "data-index": index,
      "data-msg-id": item.kind === "message" ? item.m.id : undefined,
    })),
  )
}

describe("useScrollAnchor older-page message anchoring", () => {
  let frames: FrameRequestCallback[]
  let cancelFrame: ReturnType<typeof vi.fn>
  let latest: AnchorResult

  beforeEach(() => {
    frames = []
    harness.absoluteTops.clear()
    harness.scroller = null
    harness.scrollToIndex.mockClear()
    harness.virtualizer.scrollToEnd.mockClear()
    harness.virtualizer.options.anchorTo = "end"
    cancelFrame = vi.fn()
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(cancelFrame)
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(5_000)
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const element = this as HTMLElement
      if (element.dataset.testid === "scroll") {
        return DOMRect.fromRect({ y: 0, height: 600 })
      }
      const id = element.dataset.msgId
      const top = id ? (harness.absoluteTops.get(id) ?? 0) - (harness.scroller?.scrollTop ?? 0) : 0
      return DOMRect.fromRect({ y: top, height: 80 })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function runCase(initialItems: FlatItem[], nextItems: FlatItem[], nextAnchorTop: number) {
    const onResult = (result: AnchorResult) => { latest = result }
    harness.absoluteTops.set("anchor", 120)
    const rendered = render(createElement(Harness, {
      items: initialItems,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement

    act(() => latest.captureOlderPageAnchor())
    rendered.rerender(createElement(Harness, {
      items: initialItems,
      isFetchingOlder: true,
      onResult,
    }))
    harness.absoluteTops.set("anchor", nextAnchorTop)
    rendered.rerender(createElement(Harness, {
      items: nextItems,
      isFetchingOlder: false,
      onResult,
    }))
    act(() => {
      while (frames.length > 0) frames.shift()!(0)
    })

    const anchor = rendered.container.querySelector<HTMLElement>('[data-msg-id="anchor"]')!
    expect(anchor.getBoundingClientRect().top).toBe(120)
    expect(latest.isOlderPageAnchorSettling).toBe(false)
    return rendered
  }

  function runNewerCase(initialItems: FlatItem[], nextItems: FlatItem[], nextAnchorTop: number) {
    const onResult = (result: AnchorResult) => { latest = result }
    harness.absoluteTops.set("anchor", 120)
    const rendered = render(createElement(Harness, {
      items: initialItems,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement

    act(() => latest.captureNewerPageAnchor())
    expect(latest.isNewerPageAnchorSettling).toBe(true)
    expect(harness.virtualizer.options.anchorTo).toBe("start")
    rendered.rerender(createElement(Harness, {
      items: initialItems,
      isFetchingOlder: false,
      isFetchingNewer: true,
      onResult,
    }))
    harness.scroller.scrollTop = 96
    harness.scroller.dispatchEvent(new Event("scroll"))
    harness.absoluteTops.set("anchor", nextAnchorTop)
    rendered.rerender(createElement(Harness, {
      items: nextItems,
      isFetchingOlder: false,
      isFetchingNewer: false,
      onResult,
    }))
    act(() => {
      while (frames.length > 0) frames.shift()!(0)
    })

    const anchor = rendered.container.querySelector<HTMLElement>('[data-msg-id="anchor"]')!
    expect(anchor.getBoundingClientRect().top).toBe(24)
    expect(latest.isNewerPageAnchorSettling).toBe(false)
    return rendered
  }

  it("preserves the real message across same-day and cross-day divider shapes", () => {
    const initial = [day("2026-09-18"), message("anchor")]
    const sameDay = [day("2026-09-18"), message("older"), message("anchor")]
    let rendered = runCase(initial, sameDay, 520)
    expect(harness.scrollToIndex).toHaveBeenLastCalledWith(2, { align: "start" })
    rendered.unmount()

    harness.scrollToIndex.mockClear()
    const crossDay = [
      day("2026-09-17"),
      message("older"),
      day("2026-09-18"),
      message("anchor"),
    ]
    rendered = runCase(initial, crossDay, 720)
    expect(harness.scrollToIndex).toHaveBeenLastCalledWith(3, { align: "start" })
    rendered.unmount()
  })

  it("settles an empty or fully overlapping page without moving the anchor", () => {
    const items = [day("2026-09-18"), message("anchor")]
    const rendered = runCase(items, items.slice(), 120)
    expect(harness.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "start" })
    rendered.unmount()
  })

  it("preserves the real message while a newer page appends at the loaded-window tail", () => {
    const initial = [day("2026-09-18"), message("anchor")]
    const appended = [
      day("2026-09-18"),
      message("anchor"),
      message("newer"),
    ]
    const rendered = runNewerCase(initial, appended, 120)
    expect(harness.scrollToIndex).toHaveBeenLastCalledWith(1, { align: "start" })
    expect(harness.virtualizer.scrollToEnd).not.toHaveBeenCalled()
    rendered.unmount()
  })

  it("captures newer-page scrollTop even when virtual rows lag the end intersection", () => {
    const onResult = (result: AnchorResult) => { latest = result }
    harness.absoluteTops.set("anchor", 2_000)
    const initial = [message("anchor")]
    const rendered = render(createElement(Harness, {
      items: initial,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement
    harness.scroller.scrollTop = 300

    act(() => latest.captureNewerPageAnchor())
    expect(latest.isNewerPageAnchorSettling).toBe(true)
    rendered.rerender(createElement(Harness, {
      items: initial,
      isFetchingOlder: false,
      isFetchingNewer: true,
      onResult,
    }))
    harness.scroller.scrollTop = 1_000
    harness.scroller.dispatchEvent(new Event("scroll"))
    harness.scroller.scrollTop = 1_400
    rendered.rerender(createElement(Harness, {
      items: [...initial, message("newer")],
      isFetchingOlder: false,
      isFetchingNewer: false,
      onResult,
    }))
    expect(harness.scroller.scrollTop).toBe(1_000)
    // A virtualizer/browser write can land between the synchronous restore
    // and its first reconciliation frame. The numeric fallback must repair
    // that drift even though no real row was visible at capture time.
    harness.scroller.scrollTop = 1_400
    act(() => {
      while (frames.length > 0) frames.shift()!(0)
    })

    expect(harness.scroller.scrollTop).toBe(1_000)
    expect(latest.isNewerPageAnchorSettling).toBe(false)
    rendered.unmount()
  })

  it("cancels a pending reconciliation before capturing a replacement anchor", () => {
    const onResult = (result: AnchorResult) => { latest = result }
    const initial = [message("anchor")]
    const prepended = [message("older"), message("anchor")]
    harness.absoluteTops.set("anchor", 120)
    const rendered = render(createElement(Harness, {
      items: initial,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement

    act(() => latest.captureOlderPageAnchor())
    rendered.rerender(createElement(Harness, { items: initial, isFetchingOlder: true, onResult }))
    harness.absoluteTops.set("anchor", 520)
    rendered.rerender(createElement(Harness, { items: prepended, isFetchingOlder: false, onResult }))
    expect(frames).toHaveLength(1)

    act(() => latest.captureOlderPageAnchor())
    expect(cancelFrame).toHaveBeenCalledWith(1)
    expect(latest.isOlderPageAnchorSettling).toBe(true)
    rendered.unmount()
  })

  it("clears settlement when the captured anchor disappears from the loaded window", () => {
    const onResult = (result: AnchorResult) => { latest = result }
    const initial = [message("anchor")]
    harness.absoluteTops.set("anchor", 120)
    const rendered = render(createElement(Harness, {
      items: initial,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement

    act(() => latest.captureOlderPageAnchor())
    rendered.rerender(createElement(Harness, { items: initial, isFetchingOlder: true, onResult }))
    rendered.rerender(createElement(Harness, {
      items: [day("2026-09-17")],
      isFetchingOlder: false,
      onResult,
    }))

    expect(harness.scrollToIndex).not.toHaveBeenCalled()
    expect(latest.isOlderPageAnchorSettling).toBe(false)
    rendered.unmount()
  })

  it("cancels pending reconciliation on effect replacement and unmount", () => {
    const onResult = (result: AnchorResult) => { latest = result }
    const initial = [message("anchor")]
    const prepended = [message("older"), message("anchor")]
    harness.absoluteTops.set("anchor", 120)
    const rendered = render(createElement(Harness, {
      items: initial,
      isFetchingOlder: false,
      onResult,
    }))
    harness.scroller = screen.getByTestId("scroll") as HTMLDivElement

    act(() => latest.captureOlderPageAnchor())
    rendered.rerender(createElement(Harness, { items: initial, isFetchingOlder: true, onResult }))
    harness.absoluteTops.set("anchor", 520)
    rendered.rerender(createElement(Harness, { items: prepended, isFetchingOlder: false, onResult }))
    expect(frames).toHaveLength(1)

    rendered.rerender(createElement(Harness, {
      items: prepended.slice(),
      isFetchingOlder: false,
      onResult,
    }))
    expect(cancelFrame).toHaveBeenCalledWith(1)
    expect(frames).toHaveLength(2)

    rendered.unmount()
    expect(cancelFrame).toHaveBeenCalledWith(2)
  })
})
