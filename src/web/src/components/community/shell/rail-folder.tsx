"use client"

import { memo, useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { Folder } from "lucide-react"
import { RailIndicator } from "./rail-indicator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ServerIcon } from "@/components/community/server-icon"
import { tid } from "@/lib/community/testids"
import type { FolderServer } from "@/lib/community/models/navigation"
import { RailDndBinding, type RailDndController } from "./use-server-rail-dnd"

type RailFolderProps = {
  folderId: string
  name: string
  open: boolean
  active: boolean
  unread: boolean
  onToggle: () => void
  folderServers: FolderServer[]
  dragging?: boolean
  dnd?: RailDndController
  dragDescriptionId?: string
}

function RailFolderImpl({ folderId, name, open, active, unread, onToggle, folderServers, dragging, dnd, dragDescriptionId }: RailFolderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [tooltipOpen, setTooltipOpen] = useAtom(useCreateAtom(false))
  useEffect(() => { if (dragging) setTooltipOpen(false) }, [dragging, setTooltipOpen])
  return (
    <Tooltip open={!dragging && tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger render={<div ref={rootRef} className="group relative flex h-10 w-full justify-center" />}>
        {dnd && <RailDndBinding dnd={dnd} entity={{ kind: "folder", id: folderId }} element={rootRef} handle={buttonRef} />}
        <RailIndicator active={active} unread={unread} hidden={dragging || open} testId={tid.serverRailFolderIndicator(folderId)} />
        <button ref={buttonRef} data-testid={tid.serverRailFolder(folderId)} aria-label={name} aria-expanded={open}
          aria-describedby={dragDescriptionId} data-dragging={dragging || undefined}
          onClick={onToggle} onContextMenu={(event) => event.preventDefault()} style={{ opacity: dragging ? 0.3 : 1 }}
          className="absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-xl text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing [-webkit-touch-callout:none]">
          <RailFolderIcon open={open} folderServers={folderServers} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>{name}</TooltipContent>
    </Tooltip>
  )
}
export function RailFolderIcon({ open, folderServers }: Pick<RailFolderProps, "open" | "folderServers">) {
  return open ? <Folder className="pointer-events-none size-6" /> : (
    <span className="pointer-events-none grid size-10 grid-cols-2 gap-1 p-2">
      {Array.from({ length: 4 }).map((_, index) => {
        const server = folderServers[index]
        return server ? <ServerIcon key={server.id} id={server.id} name={server.name} initial={server.initial}
          icon={server.icon} size={10} fontSize={7}
          className={`relative grid aspect-square place-items-center overflow-hidden rounded-sm text-[7px] font-semibold ${server.icon ? "bg-card text-muted-foreground" : "text-white [text-shadow:0_1px_1px_rgb(0_0_0/0.35)]"}`} />
          : <span key={index} className="aspect-square rounded-sm bg-card/50" />
      })}
    </span>
  )
}
export function railFolderPropsEqual(prev: RailFolderProps, next: RailFolderProps) {
  if (prev.folderId !== next.folderId || prev.name !== next.name || prev.open !== next.open || prev.active !== next.active || prev.unread !== next.unread || prev.dragging !== next.dragging || prev.dnd !== next.dnd || prev.dragDescriptionId !== next.dragDescriptionId || prev.folderServers.length !== next.folderServers.length) return false
  return prev.folderServers.every((server, index) => {
    const other = next.folderServers[index]
    return !!other && server.id === other.id && server.initial === other.initial && server.name === other.name && server.icon === other.icon
  })
}
export const RailFolder = memo(RailFolderImpl, railFolderPropsEqual)
