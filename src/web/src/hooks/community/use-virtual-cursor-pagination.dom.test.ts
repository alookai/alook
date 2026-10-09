import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import type { VirtualItem } from "@tanstack/react-virtual"
import { render } from "@/test/react-dom-harness"
import { useVirtualCursorPagination } from "./use-virtual-cursor-pagination"

type Props = Parameters<typeof useVirtualCursorPagination>[0]
function Harness(props: Props) {
  useVirtualCursorPagination(props)
  return null
}
const range = (...indices: number[]): VirtualItem[] => indices.map(index => ({
  index, key: index, start: index * 100, end: (index + 1) * 100, size: 100, lane: 0,
}))

describe.each(["start", "end"] as const)("native virtual cursor pagination (%s)", edge => {
  function fixture(overrides: Partial<Props> = {}) {
    let items = range(4, 5)
    const onLoad = vi.fn()
    const onBeforeLoad = vi.fn()
    const base: Props = { edge, count: 10, hasMore: true, isFetching: false,
      virtualizer: { getVirtualItems: () => items }, onLoad, onBeforeLoad, ...overrides }
    const view = render(createElement(Harness, base))
    return { base, view, onLoad, onBeforeLoad, setRange: (...indices: number[]) => { items = range(...indices) },
      rerender: (next: Partial<Props> = {}) => view.rerender(createElement(Harness, { ...base, ...next })) }
  }
  const boundary = edge === "start" ? [0, 1] : [8, 9]

  it("loads when the native range reaches the boundary, with anchor capture first", () => {
    const f = fixture()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).toHaveBeenCalledOnce()
    expect(f.onBeforeLoad.mock.invocationCallOrder[0]).toBeLessThan(f.onLoad.mock.invocationCallOrder[0])
    f.rerender()
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("rechecks a boundary reached while fetching after the request becomes idle", () => {
    const f = fixture({ isFetching: true })
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ isFetching: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("can load another page without ending a physical scrolling gesture", () => {
    const f = fixture()
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).toHaveBeenCalledOnce()
    f.rerender({ isFetching: true })
    f.setRange(...(edge === "start" ? [0, 1] : [18, 19]))
    f.rerender({ count: 20, isFetching: true })
    expect(f.onLoad).toHaveBeenCalledOnce()
    f.rerender({ count: 20, isFetching: false })
    expect(f.onLoad).toHaveBeenCalledTimes(2)
  })

  it("waits for anchor settlement and then rechecks the current range", () => {
    const f = fixture({ isSettling: true })
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ isSettling: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("does not replay demand after scrolling away during a request", () => {
    const f = fixture()
    f.setRange(...boundary)
    f.rerender()
    f.rerender({ isFetching: true })
    f.setRange(4, 5)
    f.rerender({ isFetching: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("keeps initial and target positioning separate from pagination", () => {
    const f = fixture({ enabled: false })
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ enabled: true })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("stops when the cursor is exhausted and accepts a later available cursor", () => {
    const f = fixture({ hasMore: false })
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ hasMore: true })
    expect(f.onLoad).toHaveBeenCalledOnce()
    f.rerender({ hasMore: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("ignores empty ranges, empty data and absent callbacks", () => {
    const f = fixture()
    f.setRange()
    f.rerender()
    f.setRange(...boundary)
    f.rerender({ count: 0 })
    f.rerender({ onLoad: undefined })
    expect(f.onLoad).not.toHaveBeenCalled()
    expect(f.onBeforeLoad).not.toHaveBeenCalled()
  })

  it("does not start a new fetch cycle after Query exhausts its retry policy", () => {
    const f = fixture({ isFetching: true })
    f.setRange(...boundary)
    f.rerender()
    f.rerender({ isFetching: false, isError: true })
    f.setRange(...boundary)
    f.rerender({ isFetching: false, isError: true })
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ isFetching: false, isError: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("requests one side of a short bidirectional window at a time", () => {
    const f = fixture({ hasMoreAtStart: true })
    f.setRange(0, 1, 8, 9)
    f.rerender()
    expect(f.onLoad).toHaveBeenCalledTimes(edge === "start" ? 1 : 0)
    if (edge === "end") {
      f.rerender({ hasMoreAtStart: false })
      expect(f.onLoad).toHaveBeenCalledOnce()
    }
  })

  it("has no pending input or observer work after unmount", () => {
    const f = fixture({ isFetching: true })
    f.setRange(...boundary)
    f.rerender()
    f.view.unmount()
    expect(f.onLoad).not.toHaveBeenCalled()
  })
})
