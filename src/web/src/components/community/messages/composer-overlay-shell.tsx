"use client"

import { useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react"

export function ComposerOverlayShell({
  children,
  className,
  onOverlapChange,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: ReactNode
  onOverlapChange: (overlap: number) => void
}) {
  const shellRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const overlapRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const shell = shellRef.current
    const overlay = overlayRef.current
    if (!shell || !overlay) return

    const measure = () => {
      const overlap = Math.max(0, overlay.offsetHeight - shell.offsetHeight)
      if (overlap === overlapRef.current) return
      overlapRef.current = overlap
      onOverlapChange(overlap)
    }

    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    observer.observe(overlay)
    return () => observer.disconnect()
  }, [onOverlapChange])

  return (
    <div
      {...props}
      ref={shellRef}
      data-slot="community-composer-shell"
      className={`relative h-[calc(3.75rem+var(--app-safe-area-bottom))] shrink-0 sm:h-15${
        className ? ` ${className}` : ""
      }`}
    >
      <div
        ref={overlayRef}
        data-slot="community-composer-overlay"
        className="absolute inset-x-0 bottom-0 z-30"
      >
        {children}
      </div>
    </div>
  )
}
