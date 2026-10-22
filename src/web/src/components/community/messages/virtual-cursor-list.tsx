"use client"

/* eslint-disable react-hooks/refs -- TanStack Virtual exposes an imperative instance whose render-time getters and ref callbacks are its supported React API. */

import { useLayoutEffect, type ReactNode } from "react"
import type { ReactVirtualizer } from "@tanstack/react-virtual"
import type { VirtualRowsLayoutSnapshot } from "@/hooks/community/virtualizer-react-options"

export function VirtualRows<T>({
  items,
  virtualizer,
  renderItem,
  rowRole,
  reactLayout = false,
  directDomUpdatesMode = "transform",
  children,
  getRowAttributes,
  onLayoutCommit,
}: {
  items: T[]
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>
  renderItem: (item: T, index: number) => ReactNode
  rowRole?: "listitem"
  reactLayout?: boolean
  directDomUpdatesMode?: "transform" | "position"
  children?: ReactNode
  getRowAttributes?: (item: T, index: number) => Record<`data-${string}`, string | number | undefined>
  onLayoutCommit?: (snapshot: VirtualRowsLayoutSnapshot | null) => void
}) {
  const totalSize = reactLayout ? virtualizer.getTotalSize() : null
  const virtualRows = virtualizer.getVirtualItems()
  const rows = onLayoutCommit && reactLayout ? virtualRows.map(row => ({ ...row })) : virtualRows
  const layout: VirtualRowsLayoutSnapshot | null = onLayoutCommit && reactLayout ? {
    totalSize: totalSize!,
    scrollMargin: virtualizer.options.scrollMargin,
    rows,
  } : null
  useLayoutEffect(() => {
    if (!layout || !onLayoutCommit) return
    onLayoutCommit(layout)
    return () => onLayoutCommit(null)
  })
  return (
    <div
      ref={virtualizer.containerRef}
      style={{
        position: "relative",
        width: "100%",
        ...(reactLayout ? { height: totalSize! } : {}),
      }}
    >
      {children}
      {rows.map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            {...getRowAttributes?.(item, virtualRow.index)}
            key={virtualRow.key}
            role={rowRole}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              ...(reactLayout || directDomUpdatesMode === "transform" ? { top: 0 } : {}),
              left: 0,
              width: "100%",
              ...(reactLayout ? { transform: `translate3d(0, ${virtualRow.start - (layout?.scrollMargin ?? virtualizer.options.scrollMargin)}px, 0)` } : {}),
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        )
      })}
    </div>
  )
}
