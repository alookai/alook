import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import type { MessageRequestResult } from "@/lib/community/message-position"
import type { VirtualItem } from "@tanstack/react-virtual"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { useVirtualCursorPagination } from "./use-virtual-cursor-pagination"

type Props = Parameters<typeof useVirtualCursorPagination>[0]
function Harness(props: Props) {
  const retry = useVirtualCursorPagination(props)
  return createElement("button", { onClick: retry }, "Retry page")
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

  function viewportFixture(distance: number, indices = [4, 5], overrides: Partial<Props> = {}, contentHeight = 5000) {
    const root = document.createElement("div")
    Object.defineProperties(root, {
      clientHeight: { value: 500, configurable: true },
      scrollHeight: { value: contentHeight, configurable: true },
    })
    const move = (next: number) => { root.scrollTop = edge === "start" ? next : contentHeight - 500 - next; fireEvent.scroll(root) }
    move(distance)
    const f = fixture({ preloadWithinViewport: true, virtualizer: { getVirtualItems: () => range(...indices), scrollElement: root }, ...overrides })
    return { ...f, root, move }
  }

  it("retries a failed same-window receipt once and recaptures before loading", async () => {
    const completions: Array<(result: MessageRequestResult) => void> = []
    const onLoad = vi.fn(() => ({ accepted: true as const,
      completed: new Promise<MessageRequestResult>(resolve => completions.push(resolve)) }))
    const receive = vi.fn()
    const onBeforeLoad = vi.fn(() => receive)
    const f = viewportFixture(400, [4, 5], { requestKey: {}, onLoad, onBeforeLoad })
    expect(onLoad).toHaveBeenCalledOnce()
    await act(async () => completions[0]({ status: "error" }))
    f.rerender({ isError: true })
    f.move(300)
    expect(onLoad).toHaveBeenCalledOnce()
    fireEvent.click(f.view.getByRole("button", { name: "Retry page" }))
    fireEvent.click(f.view.getByRole("button", { name: "Retry page" }))
    expect(onLoad).toHaveBeenCalledTimes(2)
    expect(onBeforeLoad).toHaveBeenCalledTimes(2)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(onBeforeLoad.mock.invocationCallOrder[1]).toBeLessThan(onLoad.mock.invocationCallOrder[1])
    await act(async () => completions[1]({ status: "success", window: {} }))
    f.rerender({ isError: false })
    f.move(200)
    expect(onLoad).toHaveBeenCalledTimes(2)
  })

  it("keeps retry subject to admission, physical distance and short-window priority", () => {
    const f = viewportFixture(400, [4, 5], { isError: true, enabled: false, hasMoreAtStart: true }, 700)
    fireEvent.click(f.view.getByRole("button", { name: "Retry page" }))
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ isError: true, enabled: true, isFetching: true })
    fireEvent.click(f.view.getByRole("button", { name: "Retry page" }))
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ isError: true, enabled: true, hasMoreAtStart: true })
    fireEvent.click(f.view.getByRole("button", { name: "Retry page" }))
    expect(f.onLoad).toHaveBeenCalledTimes(edge === "start" ? 1 : 0)
  })

  it("preloads one viewport away while the virtual range stays inside one tall row", () => {
    const f = viewportFixture(501)
    expect(f.onLoad).not.toHaveBeenCalled()
    f.move(500)
    expect(f.onLoad).toHaveBeenCalledOnce()
    f.move(499)
    expect(f.onLoad).toHaveBeenCalledOnce()
    expect(f.onBeforeLoad.mock.invocationCallOrder[0]).toBeLessThan(f.onLoad.mock.invocationCallOrder[0])
  })

  it("does not use a distant overscan boundary as the pixel preload threshold", () => {
    const f = viewportFixture(2000, boundary)
    expect(f.onLoad).not.toHaveBeenCalled()
    f.move(500)
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("deduplicates a pending window while the visible boundary keys change", () => {
    const indices = [4, 5]
    const f = viewportFixture(400, indices, { requestKey: {} })
    expect(f.onLoad).toHaveBeenCalledOnce()
    indices.splice(0, 2, 2, 3)
    f.move(300)
    indices.splice(0, 2, 0, 1)
    f.move(200)
    expect(f.onLoad).toHaveBeenCalledOnce()
    expect(f.onBeforeLoad).toHaveBeenCalledOnce()
    f.rerender({ requestKey: {} })
    expect(f.onLoad).toHaveBeenCalledTimes(2)
  })

  it("uses physical start distance when one tall virtual row occupies both edges", () => {
    const f = viewportFixture(400, [0], { count: 1, hasMoreAtStart: true })
    expect(f.onLoad).toHaveBeenCalledOnce()
    if (edge === "end") expect(f.root.scrollTop).toBeGreaterThan(f.root.clientHeight)
  })

  it("keeps eligibility, fetch and error gates on pixel scroll events and removes the listener", () => {
    const f = viewportFixture(400, [4, 5], { enabled: false })
    f.move(300)
    f.rerender({ enabled: true, isFetching: true })
    f.move(200)
    f.rerender({ enabled: true, isFetching: false, isError: true })
    f.move(100)
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ enabled: true, isFetching: false, isError: false })
    expect(f.onLoad).toHaveBeenCalledOnce()
    f.view.unmount()
    f.move(2000)
    f.move(0)
    expect(f.onLoad).toHaveBeenCalledOnce()
  })

  it("prioritizes the older side of a short pixel preload window", () => {
    const f = viewportFixture(100, [4, 5], { hasMoreAtStart: true }, 700)
    f.move(100)
    expect(f.onLoad).toHaveBeenCalledTimes(edge === "start" ? 1 : 0)
    if (edge === "end") {
      f.rerender({ hasMoreAtStart: false })
      expect(f.onLoad).toHaveBeenCalledOnce()
    }
  })

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

  it("retains semantic eligibility and rechecks the native range when the target becomes ready", () => {
    const f = fixture({ enabled: false })
    f.setRange(...boundary)
    f.rerender()
    expect(f.onLoad).not.toHaveBeenCalled()
    f.rerender({ enabled: true })
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
