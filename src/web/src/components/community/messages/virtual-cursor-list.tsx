"use client"

import { useCallback, type HTMLAttributes, type ReactNode } from "react"
import type { ReactVirtualizer } from "@tanstack/react-virtual"

export function VirtualRows<T>({
  items,
  virtualizer,
  renderItem,
  rowRole,
  directDomUpdatesMode = "transform",
  children,
  getRowAttributes,
  containerAttributes,
}: {
  items: T[]
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>
  renderItem: (item: T, index: number) => ReactNode
  rowRole?: "listitem"
  directDomUpdatesMode?: "transform" | "position"
  children?: ReactNode
  getRowAttributes?: (item: T, index: number) => Record<`data-${string}`, string | number | undefined>
  containerAttributes?: Pick<HTMLAttributes<HTMLDivElement>, "aria-hidden" | "inert"> & Record<`data-${string}`, string | number | undefined>
}) {
  const bindContainer = useCallback((node: HTMLDivElement | null) => {
    virtualizer.containerRef(node)
  }, [virtualizer])
  const rows = virtualizer.getVirtualItems()
  return (
    <div
      {...containerAttributes}
      ref={bindContainer}
      style={{
        position: "relative",
        width: "100%",
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
              ...(directDomUpdatesMode === "transform" ? { top: 0 } : {}),
              left: 0,
              width: "100%",
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        )
      })}
    </div>
  )
}
