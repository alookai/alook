"use client"

import type { ReactNode } from "react"
import type { Virtualizer } from "@tanstack/react-virtual"
import { useDeferredVirtualMeasure } from "@/hooks/community/use-deferred-virtual-measure"

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
  const measureElement = useDeferredVirtualMeasure(virtualizer)

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]
        return (
          <div
            key={itemKey(item)}
            data-index={virtualRow.index}
            ref={measureElement}
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
