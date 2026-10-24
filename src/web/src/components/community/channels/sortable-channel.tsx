"use client"

import { CommunityNavigationLink } from "../shell/community-navigation-link"
import { useAtom, useCreateAtom } from "@tanstack/react-store";

import { BellOff, Loader2, Pencil, Trash2, Users } from "lucide-react"
import { EntityIcon } from "../entity-icon"
import { useChannelDndItem } from "./channel-dnd"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, isKeyboardContextMenu } from "@/components/ui/context-menu"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropLine } from "../drop-line"
import { tid } from "@/lib/community/testids"
import type { Channel } from "@/lib/community/models/navigation"
import { selectUnreadPresentation } from "@/hooks/community/unread-presentation"
import { ChannelUnreadIndicator } from "./channel-unread-indicator"
import { useDndContextMenu } from "../use-dnd-context-menu"

export function hasChannelMenu(h: { onEdit?: () => void; onManageMembers?: () => void; onDelete?: () => void }) {
  return !!(h.onEdit || h.onManageMembers || h.onDelete)
}

// Optimistic placeholder for a channel being created. Matches SortableChannel's
// row geometry so the temp→real swap is a reveal, not a reflow. Non-interactive:
// no drag, no click, no context menu — a spinner sits where the entity icon goes.
export function PendingChannelRow({ ch }: { ch: Channel }) {
  return (
    <div
      aria-disabled
      className="group relative flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-sm text-muted-foreground opacity-60 select-none"
    >
      <span className="grid size-5 shrink-0 place-items-center opacity-70">
        <Loader2 className="size-4 animate-spin" />
      </span>
      <span className="truncate font-semibold">{ch.name}</span>
    </div>
  )
}

// A single drag-sortable channel row. The whole row is the drag surface (no handle);
// mouse movement or a touch long-press distinguishes navigation from reorder.
// Right-click opens an edit/mute/delete menu.
export function SortableChannel({ ch, href, active, onClick, onEdit, onDelete, onManageMembers, canReorder = true }: {
  ch: Channel
  href?: string
  active: boolean
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
  onManageMembers?: () => void
  canReorder?: boolean
}) {
  const [confirmingDelete, setConfirmingDelete] = useAtom(useCreateAtom(false))
  const { setNodeRef, isDragging, isOver, placement, lineSide, dragActive, suppressClick, resumeClick } = useChannelDndItem(ch.id, "channel", canReorder)
  const style = { opacity: isDragging ? 0.3 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging && placement !== "append"
  const activate = () => { if (!suppressClick()) onClick() }
  const unread = selectUnreadPresentation({
    accountUnread: ch.unread,
    active,
    muted: ch.muted === true,
  })
  const rowProps = {
    ref: setNodeRef,
    style,
    "data-testid": tid.channelRow(ch.id),
    "data-dragging": isDragging || undefined,
    "data-channel-tree-row": ch.id,
    "aria-roledescription": canReorder ? "draggable" : undefined,
    role: "button", tabIndex: 0,
    onPointerDownCapture: resumeClick,
    onTouchStartCapture: resumeClick,
    onKeyDownCapture: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " " || isKeyboardContextMenu(event.nativeEvent)) resumeClick() },
    onClickCapture: (event: React.MouseEvent) => { if (suppressClick()) { event.preventDefault(); event.stopPropagation() } },
    className: [
      "group relative flex h-8 w-full cursor-pointer touch-manipulation items-center gap-2 rounded-md px-2 text-sm select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      canReorder ? "active:cursor-grabbing" : "",
      active
        ? "bg-sidebar-accent text-foreground"
        : ch.muted
        ? "text-muted-foreground/50 hover:bg-sidebar-accent/60 hover:text-muted-foreground"
        : unread.emphasize
          ? "text-foreground hover:bg-sidebar-accent/60"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
    ].join(" "),
  }
  const content = (
    <>
      {showLine && <DropLine side={lineSide} />}
      <ChannelUnreadIndicator visible={unread.showDot} hidden={isDragging} />
      <span className="pointer-events-none grid size-5 shrink-0 place-items-center opacity-70">
      <EntityIcon kind={ch.type} className="size-4" />
      </span>
      <span className="pointer-events-none truncate font-semibold">{ch.name}</span>
      {ch.muted ? (
      <BellOff className="pointer-events-none ml-auto size-4 shrink-0 opacity-70" />
      ) : null}
    </>
  )
  const row = href ? (
    <CommunityNavigationLink {...rowProps} role="link" href={href} active={active}
      navigationDisabled={dragActive !== null} onActivate={activate}>
      {content}
    </CommunityNavigationLink>
  ) : (
    <div {...rowProps} onClick={activate}>{content}</div>
  )
  const hasMenu = hasChannelMenu({ onEdit, onManageMembers, onDelete })
  const menu = useDndContextMenu({ canOpen: hasMenu, canDrag: () => canReorder, suppressOpen: suppressClick })
  return (
    <>
      <ContextMenu disabled={!hasMenu} actionsRef={menu.actionsRef} onOpenChange={menu.onOpenChange}>
        <ContextMenuTrigger render={row} {...menu.triggerProps} />
        {hasMenu && <ContextMenuContent className="w-48">
          <div className="truncate px-2 py-2 text-xs font-semibold text-muted-foreground">/{ch.name}</div>
          {onEdit && <ContextMenuItem onClick={onEdit}><Pencil className="size-4" /> Edit channel</ContextMenuItem>}
          {onManageMembers && <ContextMenuItem onClick={onManageMembers}><Users className="size-4" /> Manage members</ContextMenuItem>}
          {onDelete && (
            <>
              {onEdit && <ContextMenuSeparator />}
              <ContextMenuItem
                onClick={() => setConfirmingDelete(true)}
                className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive"
              ><Trash2 className="size-4" /> Delete channel</ContextMenuItem>
            </>
          )}
        </ContextMenuContent>}
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
