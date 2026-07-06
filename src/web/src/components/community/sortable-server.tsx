"use client"

import { useState } from "react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import type { Server } from "./_types"

export function SortableServer({ server, active, onClick, onLeave, onOpenSettings, onOpenInvitePopover, onCreateFolder, groupTarget, inFolder, dragging: isDragActive }: { server: Server; active?: boolean; onClick: () => void; onLeave?: () => void; onOpenSettings?: () => void; onOpenInvitePopover?: () => void; onCreateFolder?: () => void; groupTarget?: boolean; inFolder?: boolean; dragging?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, activeIndex, index } = useSortable({ id: server.id })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragActive ? 0.3 : 1, zIndex: isDragging ? 10 : undefined }
  const showLine = isOver && !isDragging && !isDragActive
  const lineSide: "top" | "bottom" = activeIndex !== -1 && activeIndex < index ? "bottom" : "top"
  const [confirmLeave, setConfirmLeave] = useState(false)

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="flex w-full justify-center" />}>
          <ContextMenu>
            <ContextMenuTrigger
              render={<div ref={setNodeRef} style={style} className="group relative flex w-full justify-center" />}
            >
              {showLine && <div className={`pointer-events-none absolute inset-x-3 z-10 h-0.5 rounded-full bg-primary ${lineSide === "top" ? "-top-1" : "-bottom-1"}`} />}
              <RailIndicator active={active} />
              <div className={["relative size-10 transition-all duration-150", groupTarget ? "scale-110 rounded-xl ring-2 ring-primary" : "", isDragging ? "rounded-xl border-2 border-dashed border-muted-foreground/40" : ""].join(" ")}>
                <button
                  onClick={active ? undefined : onClick}
                  {...attributes}
                  {...listeners}
                  className={[
                    "grid size-10 touch-none place-items-center overflow-hidden text-sm font-semibold transition-all duration-150 active:cursor-grabbing",
                    active ? "cursor-default rounded-xl bg-primary text-primary-foreground" : "cursor-pointer rounded-[18px] bg-card hover:rounded-xl hover:bg-primary hover:text-primary-foreground",
                  ].join(" ")}
                >
                  {server.icon ? (
                    <img src={server.icon} alt={server.name} className="size-full object-cover" />
                  ) : (
                    server.initial
                  )}
                </button>
                {server.mentions > 0 && (
                  <span
                    className="pointer-events-none absolute -bottom-1 -right-1 grid min-w-5 place-items-center rounded-full border-[3px] border-(--d-rail) px-1 text-[11px] font-bold leading-4.5 text-white"
                    style={{ background: "var(--destructive)" }}
                  >
                    {server.mentions}
                  </span>
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{server.name}</div>
              {onOpenInvitePopover && <ContextMenuItem onClick={onOpenInvitePopover}>Invite to Server</ContextMenuItem>}
              {!inFolder && onCreateFolder && <ContextMenuItem onClick={onCreateFolder}>Create group</ContextMenuItem>}
              <ContextMenuItem onClick={onOpenSettings}>Server settings</ContextMenuItem>
              {!server.isOwner && !inFolder && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => setConfirmLeave(true)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">Leave server</ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{server.name}</TooltipContent>
      </Tooltip>
      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title={`Leave ${server.name}?`}
        description="You won't see this server's channels anymore, and you'll need a new invite to come back."
        confirmLabel="Leave server"
        confirmVariant="destructive"
        onConfirm={() => { setConfirmLeave(false); onLeave?.() }}
      />
    </>
  )
}
