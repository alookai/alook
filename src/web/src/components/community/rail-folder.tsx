"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import type { FolderServer } from "./_types"

export function RailFolder({
  sortableId, open, onToggle, activeId, folderServers, onUngroup, dragging: isDragActive,
}: {
  folderId: string
  sortableId: string
  open: boolean
  onToggle: () => void
  activeId: string
  folderServers: FolderServer[]
  onUngroup?: () => void
  dragging?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: sortableId })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragActive ? 0.3 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging && !isDragActive
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex w-full justify-center" />}>
        <ContextMenu>
          <ContextMenuTrigger
            render={<div ref={setNodeRef} style={style} className="group relative flex w-full justify-center" />}
          >
            {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
            <RailIndicator active={!open && folderServers.some((s) => s.id === activeId)} />
            <button
              onClick={onToggle}
              {...attributes}
              {...listeners}
              className={[
                "grid size-10 cursor-pointer touch-none grid-cols-2 gap-1 p-2 transition-all duration-150 active:cursor-grabbing",
                open ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent hover:rounded-xl hover:bg-primary/20",
              ].join(" ")}
            >
              {Array.from({ length: 4 }).map((_, i) => {
                const s = folderServers[i]
                return s ? (
                  <span key={s.id} className="grid aspect-square place-items-center overflow-hidden rounded-sm bg-card text-[7px] font-semibold text-muted-foreground">
                    {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : s.initial}
                  </span>
                ) : (
                  <span key={i} className="aspect-square rounded-sm bg-card/50" />
                )
              })}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onClick={onUngroup}>Ungroup</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>Group</TooltipContent>
    </Tooltip>
  )
}
