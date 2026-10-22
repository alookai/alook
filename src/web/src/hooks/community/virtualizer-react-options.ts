import type { VirtualItem } from "@tanstack/react-virtual"

export type VirtualRowsLayoutSnapshot = {
  totalSize: number
  scrollMargin: number
  rect: { width: number; height: number } | null
  rows: VirtualItem[]
}

export const COMMUNITY_VIRTUALIZER_REACT_OPTIONS = {
  useFlushSync: true,
  directDomUpdates: true,
} as const
