import React, { useRef } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useVirtualCursorSentinel } from "./use-virtual-cursor-sentinel"

type Props = {
  edge: "start" | "end"
  hasMore: boolean
  isFetching: boolean
  onLoad: () => void
}

type FakeElement = {
  id: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

let intersectionCallback: IntersectionObserverCallback
let disconnect: ReturnType<typeof vi.fn>
let observed: Element | undefined

function Harness(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useVirtualCursorSentinel({ scrollRef, ...props })
  return React.createElement(
    "div",
    { ref: scrollRef, id: "scroll" },
    React.createElement("div", { ref: sentinelRef, id: "sentinel" }),
  )
}

async function render(props: Props) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, props), {
      createNodeMock: (element) => ({
        id: element.props.id,
        scrollTop: 0,
        scrollHeight: 1_000,
        clientHeight: 400,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } satisfies FakeElement),
    })
  })
  return {
    rerender: async (next: Props) => act(async () => {
      renderer.update(React.createElement(Harness, next))
    }),
    unmount: async () => act(async () => renderer.unmount()),
  }
}

function intersect(isIntersecting: boolean) {
  act(() => {
    intersectionCallback(
      [{ isIntersecting, target: observed } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    )
  })
}

describe.each(["start", "end"] as const)("useVirtualCursorSentinel (%s edge)", (edge) => {
  beforeEach(() => {
    disconnect = vi.fn()
    observed = undefined
    class FakeIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe(element: Element) { observed = element }
      disconnect() { disconnect() }
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver)
  })

  afterEach(() => vi.unstubAllGlobals())

  it("loads on a true intersection and ignores false entries", async () => {
    const onLoad = vi.fn()
    await render({ edge, hasMore: true, isFetching: false, onLoad })
    intersect(false)
    expect(onLoad).not.toHaveBeenCalled()
    intersect(true)
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it("replays one busy demand once after settle without cascading", async () => {
    const onLoad = vi.fn()
    const view = await render({ edge, hasMore: true, isFetching: true, onLoad })
    intersect(true)
    intersect(true)
    expect(onLoad).not.toHaveBeenCalled()

    await view.rerender({ edge, hasMore: true, isFetching: false, onLoad })
    expect(onLoad).toHaveBeenCalledTimes(1)
    await view.rerender({ edge, hasMore: true, isFetching: false, onLoad })
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it("clears pending demand when hasMore becomes false and disconnects on unmount", async () => {
    const onLoad = vi.fn()
    const view = await render({ edge, hasMore: true, isFetching: true, onLoad })
    intersect(true)
    await view.rerender({ edge, hasMore: false, isFetching: false, onLoad })
    expect(onLoad).not.toHaveBeenCalled()
    await view.unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
