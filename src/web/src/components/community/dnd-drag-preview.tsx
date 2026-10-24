"use client"

import { useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react"
import { createPortal } from "react-dom"

export function DndDragPreview({ offset, width, height, returning, onReturnComplete, anchorClassName = "", children, ...props }: {
  offset: { x: number; y: number }
  width: number
  height: number
  returning: { element: HTMLElement } | null
  onReturnComplete: () => void
  anchorClassName?: string
  children: ReactNode
} & Omit<ComponentProps<"div">, "children" | "className" | "style">) {
  const anchor = useRef<HTMLDivElement>(null)
  const complete = useRef(onReturnComplete)
  useLayoutEffect(() => { complete.current = onReturnComplete }, [onReturnComplete])
  useLayoutEffect(() => {
    if (!returning || !anchor.current) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const element = returning.element
    const rect = element.getBoundingClientRect()
    if (!element.isConnected || rect.width === 0 || rect.height === 0 || media.matches) {
      complete.current()
      return
    }
    const animation = anchor.current.animate([
      { transform: `translate(${offset.x}px, ${offset.y}px)` },
      { transform: `translate(${rect.left + (rect.width - width) / 2}px, ${rect.top + (rect.height - height) / 2}px)` },
    ], { duration: 150, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" })
    animation.onfinish = () => complete.current()
    const reduce = () => { if (media.matches) complete.current() }
    media.addEventListener("change", reduce)
    return () => {
      animation.onfinish = null
      animation.cancel()
      media.removeEventListener("change", reduce)
    }
  }, [returning, width, height, offset.x, offset.y])
  return createPortal(
    <div {...props} aria-hidden="true" className="pointer-events-none fixed inset-0 z-50">
      <div ref={anchor} className={`absolute left-0 top-0 grid place-items-center ${anchorClassName}`}
        style={{ width, height, transform: `translate(${offset.x}px, ${offset.y}px)` }}>
        {children}
      </div>
    </div>, document.body,
  )
}
