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
  onResult,
}: {
  items: FlatItem[]
  isFetchingOlder: boolean
  onResult: (result: AnchorResult) => void
}) {
  const result = useScrollAnchor({
    items,
    initialScrollReady: false,
    isFetchingOlder,
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
  let latest: AnchorResult

  beforeEach(() => {
    frames = []
    harness.absoluteTops.clear()
    harness.scroller = null
    harness.scrollToIndex.mockClear()
    harness.virtualizer.scrollToEnd.mockClear()
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} })
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
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
})
