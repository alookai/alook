import { useDrag, useDragDropManager, useDrop } from "react-dnd"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render } from "@/test/react-dom-harness"
import { CommunityDndProvider } from "./community-dnd"
import { useDndContextMenu } from "./use-dnd-context-menu"

describe("Community HTML5 file isolation", () => {
  it("leaves external files to Compose, prevents outside navigation, and keeps the next real backend sort working", async () => {
    let manager!: ReturnType<typeof useDragDropManager>
    let menu!: ReturnType<typeof useDndContextMenu>
    const sorted = vi.fn(), attached = vi.fn(), closeMenu = vi.fn(), unmountMenu = vi.fn()
    function Sort() {
      manager = useDragDropManager()
      menu = useDndContextMenu({ canOpen: true, canDrag: () => true, suppressOpen: () => false })
      useLayoutEffect(() => { menu.actionsRef.current = { close: closeMenu, unmount: unmountMenu } })
      const [, drag] = useDrag(() => ({ type: "community/test-sort", item: { id: "source" } }), [])
      const [, drop] = useDrop(() => ({ accept: "community/test-sort", drop: sorted }), [])
      return <><div ref={node => { drag(node) }} data-testid="source">source</div><div ref={node => { drop(node) }} data-testid="target">target</div></>
    }
    const view = render(<>
      <CommunityDndProvider><Sort /></CommunityDndProvider>
      <div data-testid="compose" onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy" }} onDrop={event => { event.preventDefault(); event.stopPropagation(); attached(...event.dataTransfer.files) }}>compose</div>
    </>)
    const files = [new File(["document"], "notes.txt", { type: "text/plain" })]
    const transfer = { types: ["Files"], files, items: [], dropEffect: "none", getData: () => "", setData: vi.fn(), setDragImage: vi.fn() }
    for (const name of ["source", "target", "compose"]) {
      fireEvent.dragEnter(view.getByTestId(name), { dataTransfer: transfer })
      fireEvent.dragOver(view.getByTestId(name), { dataTransfer: transfer })
      expect(manager.getMonitor().isDragging()).toBe(false)
      const contextEvent = { preventDefault: vi.fn(), preventBaseUIHandler: vi.fn() }
      menu.triggerProps.onContextMenu?.(contextEvent as never)
      expect(contextEvent.preventDefault).not.toHaveBeenCalled()
      expect(contextEvent.preventBaseUIHandler).not.toHaveBeenCalled()
      expect(transfer.dropEffect).toBe(name === "compose" ? "copy" : "none")
      fireEvent.dragLeave(view.getByTestId(name), { dataTransfer: transfer })
    }
    expect(fireEvent.drop(view.getByTestId("target"), { dataTransfer: transfer })).toBe(false)
    expect(fireEvent.drop(document, { dataTransfer: transfer })).toBe(false)
    expect(attached).not.toHaveBeenCalled()
    fireEvent.dragEnter(view.getByTestId("compose"), { dataTransfer: transfer })
    fireEvent.drop(view.getByTestId("compose"), { dataTransfer: transfer })
    expect(attached).toHaveBeenCalledExactlyOnceWith(files[0])
    expect(manager.getMonitor().isDragging()).toBe(false)
    expect(sorted).not.toHaveBeenCalled()
    expect(closeMenu).not.toHaveBeenCalled()
    expect(unmountMenu).not.toHaveBeenCalled()

    const internal = { ...transfer, types: ["text/plain"], files: [] }
    fireEvent.dragStart(view.getByTestId("source"), { dataTransfer: internal })
    expect(manager.getMonitor().isDragging()).toBe(true)
    expect(closeMenu).toHaveBeenCalledOnce()
    expect(unmountMenu).toHaveBeenCalledOnce()
    fireEvent.dragEnter(view.getByTestId("target"), { dataTransfer: internal })
    fireEvent.dragOver(view.getByTestId("target"), { dataTransfer: internal })
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    fireEvent.drop(view.getByTestId("target"), { dataTransfer: internal })
    expect(sorted).toHaveBeenCalledOnce()
    fireEvent.dragEnd(view.getByTestId("source"), { dataTransfer: internal })
    expect(manager.getMonitor().isDragging()).toBe(false)
    view.unmount()

    const reopened = render(<CommunityDndProvider><Sort /></CommunityDndProvider>)
    fireEvent.dragEnter(reopened.getByTestId("target"), { dataTransfer: transfer })
    expect(manager.getMonitor().isDragging()).toBe(false)
    reopened.unmount()
  })
})
import { useLayoutEffect } from "react"
