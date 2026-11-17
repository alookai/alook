"use client"

import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react"

/** A horizontal tab tray that never hides tabs: touch swipes it natively, a mouse can drag it or
 *  scroll it with the wheel, and the selected tab is kept in view. Same behaviour as the feature
 *  gallery tray (Gus gus-issues/#274#248, #260). */
export function useTabTrayScroll(selected: number) {
  const list = useRef<HTMLDivElement>(null)
  const setList = useCallback((element: HTMLDivElement | null) => { list.current = element }, [])
  const drag = useRef<{ x: number; scroll: number; moved: boolean } | null>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const tray = list.current
    const tab = tray?.querySelectorAll<HTMLElement>('[role="tab"]')[selected]
    if (!tray || !tab) return
    const item = tab.getBoundingClientRect(), row = tray.getBoundingClientRect()
    if (item.left < row.left + 24) tray.scrollLeft += item.left - row.left - 24
    else if (item.right > row.right - 24) tray.scrollLeft += item.right - row.right + 24
  }, [selected])

  useEffect(() => {
    const tray = list.current
    if (!tray) return
    const sync = () => setOverflow(tray.scrollWidth > tray.clientWidth + 1)
    sync()
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || tray.scrollWidth <= tray.clientWidth) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tray.clientWidth : 1)
      const next = Math.max(0, Math.min(tray.scrollWidth - tray.clientWidth, tray.scrollLeft + delta))
      if (next === tray.scrollLeft) return
      event.preventDefault()
      tray.scrollLeft = next
    }
    tray.addEventListener("wheel", wheel, { passive: false })
    const observer = new ResizeObserver(sync)
    observer.observe(tray)
    return () => { tray.removeEventListener("wheel", wheel); observer.disconnect() }
  }, [])

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) { drag.current = null; return }
      drag.current = { x: event.clientX, scroll: event.currentTarget.scrollLeft, moved: false }
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const start = drag.current
      if (event.pointerType !== "mouse" || !start || !event.buttons) return
      const distance = event.clientX - start.x
      if (!start.moved && Math.abs(distance) < 6) return
      start.moved = true
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.scrollLeft = start.scroll - distance
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) },
    onPointerCancel: () => { drag.current = null },
    // A mouse press that ends a tray drag must not also select the tab under the pointer.
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => { if (event.detail > 0 && drag.current?.moved) { event.preventDefault(); event.stopPropagation(); drag.current = null } },
  }
  return { setList, overflow, handlers }
}
