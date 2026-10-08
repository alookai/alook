"use client"

/* eslint-disable react-hooks/refs -- TanStack Virtual exposes an imperative instance whose render-time getters and ref callbacks are its supported React API. */

import type { ReactNode } from "react"
import type { ReactVirtualizer } from "@tanstack/react-virtual"

export function VirtualRows<T>({
  items,
  virtualizer,
  renderItem,
  rowRole,
}: {
  items: T[]
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>
  renderItem: (item: T, index: number) => ReactNode
  rowRole?: "listitem"
}) {
  return (
    <div
      ref={virtualizer.containerRef}
      style={{
        position: "relative",
        width: "100%",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            key={virtualRow.key}
            role={rowRole}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
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
