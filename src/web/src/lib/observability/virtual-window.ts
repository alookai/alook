import type { Virtualizer } from "@tanstack/react-virtual"

type VirtualWindow = Pick<Virtualizer<Element, Element>, "getVirtualItems" | "scrollElement" | "scrollOffset">

export function visibleVirtualItems(virtualizer: VirtualWindow) {
  const root = virtualizer.scrollElement
  const start = virtualizer.scrollOffset
  if (!root || start === null || !Number.isFinite(start) || root.clientHeight <= 0) return []
  const end = start + root.clientHeight
  return virtualizer.getVirtualItems().filter(item => item.end > start && item.start < end)
}
