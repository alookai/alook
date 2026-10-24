"use client"

import { Folder, Lock } from "lucide-react"
import { useMemo } from "react"
import { DndDragPreview } from "../dnd-drag-preview"
import { EntityIcon } from "../entity-icon"
import { tid } from "@/lib/community/testids"
import type { ChannelTree, ChannelTreeEntity } from "./use-channel-tree"

export type ChannelPreviewItem = ChannelTreeEntity & { width: number; height: number }

export function ChannelDragPreview({ item, offset, tree, returning, onReturnComplete }: {
  item: ChannelPreviewItem | null
  offset: { x: number; y: number } | null
  tree: ChannelTree
  returning: { element: HTMLElement } | null
  onReturnComplete: () => void
}) {
  const channel = useMemo(() => item?.kind === "channel" ? Object.values(tree.order).flat().find(row => row.id === item.id) : undefined, [item?.kind, item?.id, tree.order])
  if (!item || !offset || item.width <= 0 || item.height <= 0) return null
  const name = channel?.name ?? tree.catNames[item.id]
  if (name === undefined) return null
  return <DndDragPreview offset={offset} width={item.width} height={item.height} returning={returning} onReturnComplete={onReturnComplete}
    data-testid={tid.channelDragPreview} data-channel-floating-preview={item.kind} data-channel-preview-phase={returning ? "returning" : "dragging"}>
    {item.kind === "channel" ? (
      <div className="flex size-full items-center gap-2 rounded-md bg-sidebar px-2 text-sm text-foreground opacity-50 select-none">
        <span className="grid size-5 shrink-0 place-items-center opacity-70"><EntityIcon kind={channel?.type} className="size-4" /></span>
        <span className="truncate font-semibold">{name}</span>
      </div>
    ) : (
      <div className="flex size-full items-center gap-1 rounded bg-sidebar px-1 py-1 text-xs font-semibold text-muted-foreground/80 opacity-50 select-none">
        {tree.catPrivate[item.id] ? <Lock className="size-3 shrink-0" /> : <Folder className="size-3 shrink-0" />}
        <span className="truncate">{name}</span>
      </div>
    )}
  </DndDragPreview>
}
