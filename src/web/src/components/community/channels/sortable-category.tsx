"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";

import type React from "react"
import { ChevronDown, Plus, Settings, Folder, Lock, Trash2 } from "lucide-react"
import { useChannelDndItem } from "./channel-dnd"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, isKeyboardContextMenu } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { tid } from "@/lib/community/testids"
import { DropLine } from "../drop-line"
import { useDndContextMenu } from "../use-dnd-context-menu"

export function hasCategoryMenu(h: { onAddChannel?: () => void; onSettings?: () => void; onDelete?: () => void }) {
  return !!(h.onAddChannel || h.onSettings || h.onDelete)
}

// A drag-sortable category. The whole header is the drag surface (no handle) — mouse
// movement or a touch long-press distinguishes collapse from reorder. It is also a drop
// target so channels can be dropped onto it (including its empty space). Right-click
// (or the gear) opens Settings; the "+" creates a channel; a lock shows when private.
export function SortableCategory({ id: catDndId, name, open, onToggle, onAddChannel, onSettings, onDelete, isPrivate, canReorder = true, pending = false, hasChannels, children }: {
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
  hasChannels: boolean
  children: React.ReactNode
}) {
  const [confirmingDelete, setConfirmingDelete] = useAtom(useCreateAtom(false))
  const { setActivatorNodeRef, setNodeRef, isDragging, isOver, placement, lineSide, suppressClick, resumeClick } = useChannelDndItem(catDndId, "category", canReorder)
  const style = { opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging && placement !== "append"
  const headerProps = {
    ref: setActivatorNodeRef,
    "data-testid": tid.categoryHeader(catDndId),
    "data-dragging": isDragging || undefined,
    role: "button", tabIndex: 0,
    "aria-label": name,
    "aria-description": isPrivate ? "Private category" : "Public category",
    "aria-expanded": hasChannels ? open : undefined,
    onPointerDownCapture: resumeClick,
    onKeyDownCapture: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " " || isKeyboardContextMenu(event.nativeEvent)) resumeClick() },
    onClick: () => { if (hasChannels && !suppressClick()) onToggle() },
    onKeyDown: (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && hasChannels && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); if (!suppressClick()) onToggle() } },
    className: `group flex w-full touch-manipulation items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-muted-foreground/80 select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${placement === "append" ? "bg-primary/5 ring-1 ring-primary" : ""} ${canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`,
  }
  const headerInner = (
    <>
      {isPrivate ? <Lock className="size-3 shrink-0" aria-hidden="true" /> : <Folder className="size-3 shrink-0" aria-hidden="true" />}
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
      {hasChannels && <ChevronDown className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />}
    </>
  )
  const hasMenu = hasCategoryMenu({ onAddChannel, onSettings, onDelete })
  const menu = useDndContextMenu({ canOpen: hasMenu, canDrag: () => canReorder, suppressOpen: suppressClick })
  return (
    <div ref={setNodeRef} data-channel-category={catDndId} style={style} className={`relative mb-4 ${pending ? "opacity-60" : ""}`}>
      {showLine && <DropLine side={lineSide} />}
      <ContextMenu disabled={!hasMenu} actionsRef={menu.actionsRef} onOpenChange={menu.onOpenChange}>
        <ContextMenuTrigger render={<div {...headerProps} />} {...menu.triggerProps}>
          {headerInner}
        </ContextMenuTrigger>
        {hasMenu && <ContextMenuContent className="w-48">
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
        </ContextMenuContent>}
      </ContextMenu>
      {open && (
        <div className={`rounded-md transition-colors ${isOver ? "bg-accent/40" : ""}`}>
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
