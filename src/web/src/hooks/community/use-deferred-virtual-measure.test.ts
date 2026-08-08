import { describe, expect, it, vi } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { useDeferredVirtualMeasure } from "./use-deferred-virtual-measure"

type MeasureRef = (node: Element | null) => void

function Harness({
  virtualizer,
  onRef,
}: {
  virtualizer: { measureElement: MeasureRef }
  onRef: (ref: MeasureRef) => void
}) {
  onRef(useDeferredVirtualMeasure(virtualizer))
  return null
}

async function renderHarness(virtualizer: { measureElement: MeasureRef }) {
  let currentRef: MeasureRef | undefined
  let renderer: TestRenderer.ReactTestRenderer
  const render = () => React.createElement(Harness, {
    virtualizer,
    onRef: (ref: MeasureRef) => { currentRef = ref },
  })
  await act(async () => {
    renderer = TestRenderer.create(render())
  })
  return {
    getRef: () => currentRef!,
    rerender: async () => {
      await act(async () => {
        renderer.update(render())
      })
    },
  }
}

describe("useDeferredVirtualMeasure", () => {
  it("measures a connected node after the current commit task", async () => {
    const measureElement = vi.fn<MeasureRef>()
    const hook = await renderHarness({ measureElement })
    const node = { isConnected: true } as Element

    hook.getRef()(node)

    expect(measureElement).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(measureElement).toHaveBeenCalledOnce()
    expect(measureElement).toHaveBeenCalledWith(node)
  })

  it("skips a node disconnected before its measurement microtask", async () => {
    const measureElement = vi.fn<MeasureRef>()
    const hook = await renderHarness({ measureElement })
    const node = { isConnected: true } as Element

    hook.getRef()(node)
    Object.defineProperty(node, "isConnected", { value: false })
    await Promise.resolve()

    expect(measureElement).not.toHaveBeenCalled()
  })

  it("defers null cleanup to the next microtask", async () => {
    const measureElement = vi.fn<MeasureRef>()
    const hook = await renderHarness({ measureElement })

    hook.getRef()(null)

    expect(measureElement).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(measureElement).toHaveBeenCalledOnce()
    expect(measureElement).toHaveBeenCalledWith(null)
  })

  it("keeps the ref callback stable while the virtualizer is unchanged", async () => {
    const hook = await renderHarness({ measureElement: vi.fn<MeasureRef>() })
    const initialRef = hook.getRef()

    await hook.rerender()

    expect(hook.getRef()).toBe(initialRef)
  })
})
