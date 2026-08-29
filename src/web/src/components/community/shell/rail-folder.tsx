"use client"

import { memo, useEffect, useRef } from "react"
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu"
import { RailIndicator } from "./rail-indicator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SeededBackdrop } from "@/components/avatar"
import { tid } from "@/lib/community/testids"
import type { FolderServer } from "@/lib/community/models/navigation"
import type { RailEntity, RailOperation } from "@/lib/community/server-rail-model"

type RailFolderProps = {
  folderId: string
  name: string
  open: boolean
  active: boolean
  unread: boolean
  onToggle: () => void
  folderServers: FolderServer[]
  onUngroup?: () => void
  dragging?: boolean
  preview?: RailOperation | null
  registerItem?: (
    entity: RailEntity,
    element: HTMLElement,
    dragHandle: HTMLElement,
  ) => () => void
  dragDescriptionId?: string
}

function RailFolderImpl({
  folderId, name, open, active, unread, onToggle, folderServers, onUngroup, dragging: isDragActive,
  preview, registerItem, dragDescriptionId,
}: RailFolderProps) {
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
            <RailIndicator
              active={active}
              unread={unread}
              testId={tid.serverRailFolderIndicator(folderId)}
            />
            <button
              ref={buttonRef}
              data-testid={tid.serverRailFolder(folderId)}
              data-dragging={isDragActive || undefined}
              data-rail-preview={preview ?? undefined}
              aria-label={name}
              aria-describedby={dragDescriptionId}
              aria-keyshortcuts="Space ArrowUp ArrowDown Escape"
              onClick={onToggle}
              className="group/folder grid size-11 cursor-pointer place-items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
            >
              <span className={[
                "pointer-events-none grid size-10 grid-cols-2 gap-1 p-2 transition-[border-radius,background-color] duration-150",
                open ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent group-hover/folder:rounded-xl group-hover/folder:bg-primary/20",
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
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onClick={onUngroup}>Ungroup</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{name}</TooltipContent>
    </Tooltip>
  )
}

export function railFolderPropsEqual(prev: RailFolderProps, next: RailFolderProps) {
  if (
    prev.folderId !== next.folderId ||
    prev.name !== next.name ||
    prev.open !== next.open ||
    prev.active !== next.active ||
    prev.unread !== next.unread ||
    prev.dragging !== next.dragging ||
    prev.preview !== next.preview ||
    !!prev.onUngroup !== !!next.onUngroup ||
    !!prev.registerItem !== !!next.registerItem ||
    prev.dragDescriptionId !== next.dragDescriptionId ||
    prev.folderServers.length !== next.folderServers.length
  ) return false
  return prev.folderServers.every((server, index) => {
    const other = next.folderServers[index]
    return !!other &&
      server.id === other.id &&
      server.name === other.name &&
      server.initial === other.initial &&
      server.icon === other.icon
  })
}

export const RailFolder = memo(RailFolderImpl, railFolderPropsEqual)
