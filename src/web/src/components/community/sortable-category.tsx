"use client"

import { useState } from "react"
import type React from "react"
import { ChevronDown, Plus, Settings, Lock, Trash2 } from "lucide-react"
import { useSortable } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropLine } from "./drop-line"

// A drag-sortable category. The whole header is the drag surface (no handle) — a 5px
// activation distance distinguishes a click (collapse) from a drag. It is also a drop
// target so channels can be dropped onto it (including its empty space). Right-click
// (or the gear) opens Settings; the "+" creates a channel; a lock shows when private.
export function SortableCategory({ id: catDndId, name, open, onToggle, onAddChannel, onSettings, onDelete, isPrivate, children }: {
  id: string
  name: string
  open: boolean
  onToggle: () => void
  onAddChannel?: () => void
  onSettings?: () => void
  onDelete?: () => void
  isPrivate?: boolean
  children: React.ReactNode
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: catDndId })
  const { setNodeRef: setDropRef, isOver: isChannelOver } = useDroppable({ id: catDndId })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  return (
    <div ref={setNodeRef} style={style} className="relative mb-4">
      {showLine && <DropLine side={lineSide} />}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              {...attributes}
              {...listeners}
              onClick={onToggle}
              className="group flex w-full cursor-grab touch-none items-center gap-1 rounded px-1 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 hover:text-foreground active:cursor-grabbing"
            />
          }
        >
          {isPrivate && <Lock className="size-3 shrink-0" />}
          <span className="flex-1 truncate text-left">{name}</span>
          {onSettings && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onSettings() }}
            className="grid size-4 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
            aria-label={`Category settings for ${name}`}
          >
            <Settings className="size-3.5" />
          </button>
          )}
          {onAddChannel && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onAddChannel() }}
            className="grid size-4 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
            aria-label={`Create channel in ${name}`}
          >
            <Plus className="size-3.5" />
          </button>
          )}
          <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <div className="truncate px-2 py-2 text-xs font-semibold text-muted-foreground">{name}</div>
          {onAddChannel && <ContextMenuItem onClick={onAddChannel}><Plus className="size-4" /> Create channel</ContextMenuItem>}
          {onSettings && <ContextMenuItem onClick={onSettings}><Settings className="size-4" /> Category settings</ContextMenuItem>}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setConfirmingDelete(true)}
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              ><Trash2 className="size-4" /> Delete category</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {open && (
        <div ref={setDropRef} className={`rounded-md transition-colors ${isChannelOver ? "bg-accent/40" : ""}`}>
          {children}
        </div>
      )}
      {onDelete && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete ${name}?`}
          description="Channels inside this category will also be removed. This can't be undone."
          confirmLabel="Delete category"
          onConfirm={() => { setConfirmingDelete(false); onDelete() }}
        />
      )}
    </div>
  )
}
