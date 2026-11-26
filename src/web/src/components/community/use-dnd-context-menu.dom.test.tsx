import { useLayoutEffect, type ContextType } from "react"
import { DndContext } from "react-dnd"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { useDndContextMenu } from "./use-dnd-context-menu"

type DragDropManager = NonNullable<ContextType<typeof DndContext>["dragDropManager"]>

function createFakeManager() {
  let dragging = false
  const listeners = new Set<() => void>()
  const unsubscribeSpies: Array<ReturnType<typeof vi.fn>> = []
  const subscribeToStateChange = vi.fn((listener: () => void) => {
    listeners.add(listener)
    const unsubscribe = vi.fn(() => {
      listeners.delete(listener)
    })
    unsubscribeSpies.push(unsubscribe)
    return unsubscribe
  })
  const manager = {
    getMonitor: () => ({
      isDragging: () => dragging,
      subscribeToStateChange,
    }),
  } as unknown as DragDropManager
  return {
    manager,
    subscribeToStateChange,
    unsubscribeSpies,
    setDragging(next: boolean) {
      dragging = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

describe("useDndContextMenu", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("keeps a single drag-start listener across rerenders and unsubscribes on manager swap and unmount", () => {
    const first = createFakeManager()
    const second = createFakeManager()
    const close = vi.fn()
    const unmount = vi.fn()

    function Harness({ tick, canOpen = true }: { tick: number; canOpen?: boolean }) {
      const menu = useDndContextMenu({
        canOpen,
        canDrag: () => tick >= 0,
        suppressOpen: () => false,
      })
      useLayoutEffect(() => {
        menu.actionsRef.current = { close, unmount }
      })
      return null
    }

    const view = render(
      <DndContext.Provider value={{ dragDropManager: first.manager }}>
        <Harness tick={0} />
      </DndContext.Provider>,
    )

    for (let tick = 1; tick <= 8; tick += 1) {
      view.rerender(
        <DndContext.Provider value={{ dragDropManager: first.manager }}>
          <Harness tick={tick} />
        </DndContext.Provider>,
      )
    }

    expect(first.subscribeToStateChange).toHaveBeenCalledTimes(1)
    expect(first.listenerCount()).toBe(1)

    act(() => { first.setDragging(true) })
    expect(close).toHaveBeenCalledTimes(1)
    expect(unmount).toHaveBeenCalledTimes(1)
    act(() => { first.setDragging(false) })

    // Swap managers: old manager must be completely detached and unsubscribed.
    view.rerender(
      <DndContext.Provider value={{ dragDropManager: second.manager }}>
        <Harness tick={9} />
      </DndContext.Provider>,
    )
    expect(first.listenerCount()).toBe(0)
    expect(first.unsubscribeSpies[0]).toHaveBeenCalledTimes(1)
    expect(second.subscribeToStateChange).toHaveBeenCalledTimes(1)
    expect(second.listenerCount()).toBe(1)

    act(() => { first.setDragging(true) })
    expect(close).toHaveBeenCalledTimes(1)
    expect(unmount).toHaveBeenCalledTimes(1)

    act(() => { second.setDragging(true) })
    expect(close).toHaveBeenCalledTimes(2)
    expect(unmount).toHaveBeenCalledTimes(2)

    view.unmount()
    expect(second.listenerCount()).toBe(0)
    expect(second.unsubscribeSpies[0]).toHaveBeenCalledTimes(1)
  })

  it("detaches shared blur and visibility listeners cleanly after rerenders during touch hold", () => {
    const fake = createFakeManager()
    const addWindowListener = vi.spyOn(window, "addEventListener")
    const removeWindowListener = vi.spyOn(window, "removeEventListener")
    const addDocListener = vi.spyOn(document, "addEventListener")
    const removeDocListener = vi.spyOn(document, "removeEventListener")
    let latestMenu!: ReturnType<typeof useDndContextMenu>

    function Harness({ tick }: { tick: number }) {
      const menu = useDndContextMenu({
        canOpen: true,
        canDrag: () => tick >= 0,
        suppressOpen: () => false,
      })
      useLayoutEffect(() => { latestMenu = menu })
      return null
    }

    const view = render(
      <DndContext.Provider value={{ dragDropManager: fake.manager }}>
        <Harness tick={0} />
      </DndContext.Provider>,
    )

    const node = document.createElement("div")
    document.body.appendChild(node)
    try {
      act(() => {
        latestMenu.triggerProps.onTouchStart?.({
          currentTarget: node,
          touches: [{ clientX: 10, clientY: 20 }],
          preventBaseUIHandler: vi.fn(),
        } as never)
      })
      const blurAdds = addWindowListener.mock.calls.filter(([type]) => String(type) === "blur").length
      const visAdds = addDocListener.mock.calls.filter(([type]) => String(type) === "visibilitychange").length
      expect(blurAdds).toBe(1)
      expect(visAdds).toBe(1)

      // Rerender several times while touch hold is active.
      for (let tick = 1; tick <= 4; tick += 1) {
        view.rerender(
          <DndContext.Provider value={{ dragDropManager: fake.manager }}>
            <Harness tick={tick} />
          </DndContext.Provider>,
        )
      }

      act(() => { window.dispatchEvent(new Event("blur")) })
      const blurRemovals = removeWindowListener.mock.calls.filter(([type]) => String(type) === "blur").length
      const visRemovals = removeDocListener.mock.calls.filter(([type]) => String(type) === "visibilitychange").length
      expect(blurRemovals).toBe(1)
      expect(visRemovals).toBe(1)
    } finally {
      view.unmount()
      node.remove()
    }
  })
})
