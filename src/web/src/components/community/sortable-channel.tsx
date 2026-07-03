"use client"

import { useState } from "react"
import { ListChevronsUpDown, BellOff, Pencil, Trash2 } from "lucide-react"
import { ChannelIcon } from "./channel-icon"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropLine } from "./drop-line"
import type { Channel } from "./_types"

// A single drag-sortable channel row. The whole row is the drag surface (no handle);
// a 5px activation distance keeps a tap = "switch channel" and a drag = reorder.
// Right-click opens an edit/mute/delete menu.
export function SortableChannel({ ch, active, onClick, onEdit, onDelete }: {
  ch: Channel
  active: boolean
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: ch.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  const row = (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      {...attributes}
      {...listeners}
      className={[
        "group relative flex h-8 w-full cursor-pointer touch-none items-center gap-2 rounded-md px-2 text-sm active:cursor-grabbing",
        active
          ? "bg-sidebar-accent text-foreground"
          : ch.muted
            ? "text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-muted-foreground"
            : ch.unread
              ? "text-foreground hover:bg-sidebar-accent/60"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
      ].join(" ")}
    >
      {showLine && <DropLine side={lineSide} />}
      <span className="grid size-5 shrink-0 place-items-center opacity-70">
        {ch.type === "forum" ? (
          <ListChevronsUpDown className="size-4" />
        ) : (
          <ChannelIcon className="size-4" />
        )}
      </span>
      <span className="truncate font-semibold">{ch.name}</span>
      {ch.muted ? (
        <BellOff className="ml-auto size-4 shrink-0 opacity-70" />
      ) : ch.unread && !active ? (
        <span className="ml-auto size-2 rounded-full bg-primary" />
      ) : null}
    </div>
  )
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={row} />
        <ContextMenuContent className="w-48">
          <div className="truncate px-2 py-2 text-xs font-semibold text-muted-foreground">/{ch.name}</div>
          {onEdit && <ContextMenuItem onClick={onEdit}><Pencil className="size-4" /> Edit channel</ContextMenuItem>}
          {onDelete && (
            <>
              {onEdit && <ContextMenuSeparator />}
              <ContextMenuItem
                onClick={() => setConfirmingDelete(true)}
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              ><Trash2 className="size-4" /> Delete channel</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {onDelete && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={`Delete /${ch.name}?`}
          description="This channel and its message history will be removed for everyone. This can't be undone."
          confirmLabel="Delete channel"
          onConfirm={() => { setConfirmingDelete(false); onDelete() }}
        />
      )}
    </>
  )
}
