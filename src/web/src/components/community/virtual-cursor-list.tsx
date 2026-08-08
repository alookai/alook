"use client"

import type { ReactNode } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"

export function VirtualRows<T>({
  items,
  virtualizer,
  itemKey,
  renderItem,
}: {
  items: T[]
  virtualizer: Virtualizer<HTMLDivElement, Element>
  itemKey: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
}) {
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            key={itemKey(item)}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
            }}
          >
            {renderItem(item, virtualRow.index)}
          </div>
        )
      })}
    </div>
  )
}
