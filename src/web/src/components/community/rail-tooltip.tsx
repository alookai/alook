"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

// Rail icon hover tooltip — portaled to body with fixed positioning so it never
// widens the rail (a `left-full` absolute child would force horizontal overflow on
// the overflow-y-auto nav, enabling stray horizontal scroll/drag). Hover is bound to
// the parent icon element directly, so no overlay blocks its clicks or drag.
export function RailTooltip({ label }: { label: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const parent = anchorRef.current?.parentElement
    if (!parent) return
    const show = () => {
      const r = parent.getBoundingClientRect()
      // anchor to the icon's visual center (40px) + 8px gap, not the 72px-wide parent's edge
      setPos({ x: r.left + r.width / 2 + 20 + 8, y: r.top + r.height / 2 })
    }
    const hide = () => setPos(null)
    parent.addEventListener("mouseenter", show)
    parent.addEventListener("mouseleave", hide)
    parent.addEventListener("pointerdown", hide) // drag/click dismisses it
    return () => {
      parent.removeEventListener("mouseenter", show)
      parent.removeEventListener("mouseleave", hide)
      parent.removeEventListener("pointerdown", hide)
    }
  }, [])
  return (
    <>
      <span ref={anchorRef} className="hidden" />
      {pos && createPortal(
        <span
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-sm font-medium text-popover-foreground shadow-(--e2)"
          style={{ left: pos.x, top: pos.y }}
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  )
}
