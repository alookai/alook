"use client"

import { useCallback, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react"
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
  containerAttributes,
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
  containerAttributes?: Pick<HTMLAttributes<HTMLDivElement>, "aria-hidden" | "inert"> & Record<`data-${string}`, string | number | undefined>
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bindContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    virtualizer.containerRef(node)
  }, [virtualizer])
  const totalSize = reactLayout ? virtualizer.getTotalSize() : null
  const virtualRows = virtualizer.getVirtualItems()
  const rows = onLayoutCommit && reactLayout ? virtualRows.map(row => ({ ...row })) : virtualRows
  const layout = onLayoutCommit && reactLayout ? {
    totalSize: totalSize!,
    scrollMargin: virtualizer.options.scrollMargin,
    rows,
  } : null
  useLayoutEffect(() => {
    if (!layout || !onLayoutCommit) return
    const root = virtualizer.options.getScrollElement()
    const container = containerRef.current
    onLayoutCommit({ ...layout, container, physicalScrollMargin: root && container
      ? container.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop + root.scrollTop
      : layout.scrollMargin })
    return () => onLayoutCommit(null)
  })
  return (
    <div
      {...containerAttributes}
      ref={bindContainer}
      style={{
        position: "relative",
        width: "100%",
        ...(reactLayout ? { height: totalSize!, flexShrink: 0 } : {}),
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
