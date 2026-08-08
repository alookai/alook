"use client"

import { useCallback } from "react"

type VirtualMeasureTarget<TItemElement extends Element> = {
  measureElement: (node: TItemElement | null) => void
}

export function useDeferredVirtualMeasure<TItemElement extends Element>(
  virtualizer: VirtualMeasureTarget<TItemElement>,
) {
  return useCallback((node: TItemElement | null) => {
    queueMicrotask(() => {
      if (node && !node.isConnected) return
      virtualizer.measureElement(node)
    })
  }, [virtualizer])
}
