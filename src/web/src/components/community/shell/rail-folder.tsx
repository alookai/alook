"use client"

import { useEffect, useRef } from "react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SeededBackdrop } from "@/components/avatar"
import { tid } from "@/lib/community/testids"
import type { FolderServer } from "@/lib/community/models/navigation"
import type { RailEntity, RailOperation } from "@/lib/community/server-rail-model"

export function RailFolder({
  folderId, open, onToggle, activeId, folderServers, onUngroup, dragging: isDragActive,
  preview, registerItem, onMove,
}: {
  folderId: string
  open: boolean
  onToggle: () => void
  activeId: string
  folderServers: FolderServer[]
  onUngroup?: () => void
  dragging?: boolean
  preview?: RailOperation | null
  registerItem?: (
    entity: RailEntity,
    element: HTMLElement,
    dragHandle: HTMLElement,
  ) => () => void
  onMove?: (source: RailEntity, focusTarget: HTMLElement) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!registerItem || !rootRef.current || !buttonRef.current) return
    return registerItem(
      { kind: "folder", id: folderId },
      rootRef.current,
      buttonRef.current,
    )
  }, [folderId, registerItem])

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex w-full justify-center" />}>
        <ContextMenu>
          <ContextMenuTrigger
            render={<div ref={rootRef} style={{ opacity: isDragActive ? 0.3 : 1 }} className="group relative flex w-full justify-center" />}
          >
            {(preview === "reorder-before" || preview === "reorder-after") && (
              <div
                data-testid={tid.serverRailInsertFolder(folderId)}
                className={`pointer-events-none absolute left-1/2 z-10 h-0.5 w-9 -translate-x-1/2 rounded-full bg-primary ${preview === "reorder-before" ? "-top-1" : "-bottom-1"}`}
              />
            )}
            <RailIndicator active={!open && folderServers.some((s) => s.id === activeId)} />
            <button
              ref={buttonRef}
              data-testid={tid.serverRailFolder(folderId)}
              onClick={onToggle}
              className={[
                "grid size-10 cursor-pointer touch-manipulation grid-cols-2 gap-1 p-2 transition-[border-radius,background-color] duration-150 active:cursor-grabbing",
                open ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent hover:rounded-xl hover:bg-primary/20",
                preview === "combine" ? "bg-primary/10 outline outline-2! outline-primary" : "",
              ].join(" ")}
            >
              {Array.from({ length: 4 }).map((_, i) => {
                const s = folderServers[i]
                return s ? (
                  <span
                    key={s.id}
                    className={[
                      "relative grid aspect-square place-items-center overflow-hidden rounded-sm text-[7px] font-semibold",
                      s.icon ? "bg-card text-muted-foreground" : "text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.35)]",
                    ].join(" ")}
                  >
                    {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : <><SeededBackdrop seed={s.id} /><span className="relative">{s.initial}</span></>}
                  </span>
                ) : (
                  <span key={i} className="aspect-square rounded-sm bg-card/50" />
                )
              })}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            {onMove && (
              <ContextMenuItem onClick={() => {
                if (buttonRef.current) onMove({ kind: "folder", id: folderId }, buttonRef.current)
              }}>
                Move…
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={onUngroup}>Ungroup</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>Group</TooltipContent>
    </Tooltip>
  )
}
