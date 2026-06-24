"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { RailTooltip } from "./rail-tooltip"
import type { Server } from "./_types"

// Drag-sortable server icon — handle-less (5px activation), tooltip, mention badge, drop line.
export function SortableServer({ server, active, onClick, onLeave }: { server: Server; active?: boolean; onClick: () => void; onLeave?: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: server.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div ref={setNodeRef} style={style} className="group relative flex w-full justify-center" />}
      >
        {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
        <RailIndicator active={active} />
        {/* icon wrapper sized to the icon so the badge anchors to its corner */}
        <div className="relative size-10">
          <button
            onClick={onClick}
            {...attributes}
            {...listeners}
            className={[
              "grid size-10 cursor-pointer touch-none place-items-center text-sm font-semibold transition-all duration-150 active:cursor-grabbing",
              active ? "rounded-xl bg-primary text-primary-foreground" : "rounded-[18px] bg-card hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
            ].join(" ")}
          >
            {server.initial}
          </button>
          {server.mentions > 0 && (
            <span
              className="pointer-events-none absolute -bottom-1 -right-1 grid min-w-5 place-items-center rounded-full border-[3px] border-(--d-rail) px-1 text-[11px] font-bold leading-4.5 text-white"
              style={{ background: "oklch(0.62 0.21 25)" }}
            >
              {server.mentions}
            </span>
          )}
        </div>
        <RailTooltip label={server.name} />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{server.name}</div>
        <ContextMenuItem>Mark As Read</ContextMenuItem>
        <ContextMenuItem>Mute Server</ContextMenuItem>
        <ContextMenuItem>Notification Settings</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onLeave} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">Leave Server</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
