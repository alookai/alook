"use client"

import { Button } from "@/components/ui/button"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import type React from "react"
import { memo, useCallback } from "react"
import { ChevronDown, Plus, Settings, MessagesSquare, MessageSquareLock, Trash2 } from "@/components/icons/lucide";
import { ChannelDndBinding, useChannelDndRow } from "./channel-dnd"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, isKeyboardContextMenu } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { tid } from "@/lib/community/testids"
import { DropLine } from "../drop-line"
import { useDndContextMenu } from "../use-dnd-context-menu"

export function hasCategoryMenu(h: { onAddChannel?: unknown; onSettings?: unknown; onDelete?: unknown; onRequestDelete?: unknown }) {
  return !!(h.onAddChannel || h.onSettings || h.onDelete || h.onRequestDelete)
}

// A drag-sortable category. The whole header is the drag surface (no handle) — mouse
// movement or a touch long-press distinguishes collapse from reorder. It is also a drop
// target so channels can be dropped onto it (including its empty space). Right-click
// (or the gear) opens Settings; the "+" creates a channel; a lock shows when private.
export const SortableCategory = memo(function SortableCategory({
  id: catDndId,
  name,
  open,
  onToggle,
  onAddChannel,
  onSettings,
  onDelete,
  onRequestDelete,
  isPrivate,
  canReorder = true,
  pending = false,
  hasChannels,
  className,
  children,
}: {
  id: string
  name: string
  open: boolean
  onToggle: (id: string) => void
  onAddChannel?: (id: string) => void
  onSettings?: (id: string) => void
  onDelete?: (id: string) => void
  onRequestDelete?: (id: string, name: string) => void
  isPrivate?: boolean
  canReorder?: boolean
  pending?: boolean
  hasChannels: boolean
  className?: string
  children?: React.ReactNode
}) {
  const [confirmingDelete, setConfirmingDelete] = useAtom(useCreateAtom(false))
  const [menuActivated, setMenuActivated] = useAtom(useCreateAtom(false))
  const {
    elementRef,
    headerRef,
    pressAllowsDragRef,
    bindingRef,
    setActivatorNodeRef,
    setNodeRef,
    isDragging,
    isOver,
    placement,
    lineSide,
    suppressClick,
    resumeClick,
  } = useChannelDndRow(catDndId, "category")
  const style = { opacity: isDragging ? 0.3 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging && placement !== "append"
  const activateMenu = menuActivated ? undefined : () => setMenuActivated(true)
  const hasMenu = hasCategoryMenu({ onAddChannel, onSettings, onDelete, onRequestDelete })
  const menu = useDndContextMenu({ canOpen: hasMenu, canDrag: () => canReorder, suppressOpen: suppressClick })
  const handleMenuOpenChange = useCallback<NonNullable<React.ComponentProps<typeof ContextMenu>["onOpenChange"]>>((nextOpen, details) => {
    if (nextOpen && !menuActivated) setMenuActivated(true)
    menu.onOpenChange(nextOpen, details)
  }, [menu, menuActivated, setMenuActivated])
  const headerProps = {
    ref: setActivatorNodeRef,
    "data-testid": tid.categoryHeader(catDndId),
    "data-dragging": isDragging || undefined,
    role: "button", tabIndex: 0,
    "aria-label": name,
    "aria-description": isPrivate ? "Private category" : "Public category",
    "aria-expanded": hasChannels ? open : undefined,
    onPointerEnter: activateMenu,
    onPointerDownCapture: (event: React.PointerEvent<HTMLElement>) => { activateMenu?.(); resumeClick(event) },
    onTouchStartCapture: (event: React.TouchEvent<HTMLElement>) => { activateMenu?.(); resumeClick(event) },
    onFocusCapture: activateMenu,
    onContextMenuCapture: activateMenu,
    onKeyDownCapture: (event: React.KeyboardEvent<HTMLElement>) => {
      activateMenu?.()
      if (event.key === "Enter" || event.key === " " || isKeyboardContextMenu(event.nativeEvent)) resumeClick(event)
    },
    onClick: () => { if (hasChannels && !suppressClick()) onToggle(catDndId) },
    onKeyDown: (event: React.KeyboardEvent) => { if (event.target === event.currentTarget && hasChannels && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); if (!suppressClick()) onToggle(catDndId) } },
    className: `group flex w-full touch-manipulation items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-muted-foreground/80 select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${placement === "append" ? "bg-primary/5 ring-1 ring-primary" : ""} ${canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"}`,
  }
  const headerInner = (
    <>
      {isPrivate ? <MessageSquareLock className="pointer-events-none size-3 shrink-0" aria-hidden="true" /> : <MessagesSquare className="pointer-events-none size-3 shrink-0" aria-hidden="true" />}
      <span className="pointer-events-none flex-1 truncate text-left">{name}</span>
      {onSettings && (
      <Button variant="ghost" size="icon"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onSettings(catDndId) }}
        className="hidden size-4 place-items-center rounded hover:bg-accent sm:grid sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        aria-label={`Category settings for ${name}`}
      >
        <Settings className="size-3" />
      </Button>
      )}
      {onAddChannel && (
      <Button variant="ghost" size="icon"
        onPointerDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
        onClick={(e) => { e.stopPropagation(); onAddChannel(catDndId) }}
        className="hidden size-4 place-items-center rounded hover:bg-accent sm:grid sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        aria-label={`Create channel in ${name}`}
      >
        <Plus className="size-3" />
      </Button>
      )}
      {hasChannels && <ChevronDown className={`pointer-events-none size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />}
    </>
  )
  const canDelete = Boolean(onRequestDelete || onDelete)
  const triggerDelete = () => {
    if (onRequestDelete) onRequestDelete(catDndId, name)
    else setConfirmingDelete(true)
  }
  return (
    <div ref={setNodeRef} data-channel-category={catDndId} style={style} className={`relative ${className ?? "mb-4"} ${pending ? "opacity-60" : ""}`}>
      {showLine && <DropLine side={lineSide} />}
      <ContextMenu disabled={!hasMenu} actionsRef={menu.actionsRef} onOpenChange={handleMenuOpenChange}>
        <ContextMenuTrigger render={<div {...headerProps} />} {...menu.triggerProps}>
          {headerInner}
        </ContextMenuTrigger>
        {hasMenu && menuActivated && <ContextMenuContent className="w-48">
          <div className="truncate px-2 py-2 text-xs font-semibold text-muted-foreground">{name}</div>
          {onAddChannel && <ContextMenuItem onClick={() => onAddChannel(catDndId)}><Plus className="size-4" /> Create channel</ContextMenuItem>}
          {onSettings && <ContextMenuItem onClick={() => onSettings(catDndId)}><Settings className="size-4" /> Category settings</ContextMenuItem>}
          {canDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={triggerDelete}
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              ><Trash2 className="size-4" /> Delete category</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>}
      </ContextMenu>
      {canReorder && (
        <ChannelDndBinding
          id={catDndId}
          kind="category"
          elementRef={elementRef}
          headerRef={headerRef}
          pressAllowsDragRef={pressAllowsDragRef}
          bindingRef={bindingRef}
        />
      )}
      {open && children != null && (
        <div className={`rounded-md transition-colors ${isOver ? "bg-accent/40" : ""}`}>
          {children}
        </div>
      )}
      {onDelete && !onRequestDelete && confirmingDelete && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete ${name}?`}
          description="Channels inside this category will also be removed. This can't be undone."
          confirmLabel="Delete category"
          onConfirm={() => { setConfirmingDelete(false); onDelete(catDndId) }}
        />
      )}
    </div>
  )
})
