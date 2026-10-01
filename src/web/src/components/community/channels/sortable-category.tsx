"use client"

import { useState } from "react"
import type React from "react"
import { Plus, Settings, Trash2 } from "lucide-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropLine } from "../drop-line"
import { ChannelCategory } from "./channel-category"

// True when the category header has at least one right-click action. With none, we skip
// the ContextMenu wrapper so a non-admin doesn't get an empty popover strip.
export function hasCategoryMenu(h: { onAddChannel?: () => void; onSettings?: () => void; onDelete?: () => void }) {
  return !!(h.onAddChannel || h.onSettings || h.onDelete)
}

// A drag-sortable category. The whole header is the drag surface (no handle) — mouse
// movement or a touch long-press distinguishes collapse from reorder. It is also a drop
// target so channels can be dropped onto it (including its empty space). Right-click
// (or the gear) opens Settings; the "+" creates a channel; a lock shows when private.
export function SortableCategory({ id: catDndId, name, open, onToggle, onAddChannel, onSettings, onDelete, isPrivate, canReorder = true, pending = false, children }: {
  id: string
  name: string
  open: boolean
  onToggle: () => void
  onAddChannel?: () => void
  onSettings?: () => void
  onDelete?: () => void
  isPrivate?: boolean
  canReorder?: boolean
  pending?: boolean
  children: React.ReactNode
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: catDndId, data: { kind: "category" }, disabled: !canReorder })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  // The header div is the drag surface; it renders bare (no ContextMenu) when there are no
  // actions, so share its props/children across both branches to avoid drift.
  const headerProps = {
    ref: setActivatorNodeRef,
    ...attributes,
    ...listeners,
    onTouchStart: undefined,
    onTouchStartCapture: listeners?.onTouchStart
      ? (event: React.TouchEvent<HTMLDivElement>) => listeners.onTouchStart?.(event)
      : undefined,
    className: canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
  }
  return (
    <div ref={setNodeRef} style={style} className={`relative mb-4 ${pending ? "opacity-60" : ""}`}>
      {showLine && <DropLine side={lineSide} />}
      <ChannelCategory
        name={name} open={open} onToggle={onToggle} isPrivate={isPrivate}
        onSettings={onSettings} onAddChannel={onAddChannel} headerProps={headerProps} highlighted={isOver}
        renderHeader={hasCategoryMenu({ onAddChannel, onSettings, onDelete }) ? (header) => (
          <ContextMenu>
            <ContextMenuTrigger render={header} />
            <ContextMenuContent className="w-48">
              <div className="truncate px-2 py-2 text-xs font-semibold text-muted-foreground">{name}</div>
              {onAddChannel && <ContextMenuItem onClick={onAddChannel}><Plus className="size-4" /> Create channel</ContextMenuItem>}
              {onSettings && <ContextMenuItem onClick={onSettings}><Settings className="size-4" /> Category settings</ContextMenuItem>}
              {onDelete && <><ContextMenuSeparator /><ContextMenuItem onClick={() => setConfirmingDelete(true)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"><Trash2 className="size-4" /> Delete category</ContextMenuItem></>}
            </ContextMenuContent>
          </ContextMenu>
        ) : undefined}
      >
        {children}
      </ChannelCategory>
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
