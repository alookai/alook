"use client"

import { DndDragPreview } from "../dnd-drag-preview"
import type { Server } from "@/lib/community/models/navigation"
import { RailServerIcon } from "./rail-server-icon"
import { RailFolderIcon } from "./rail-folder"
import { useServerRailDrag, type RailDndController } from "./use-server-rail-dnd"
import type { RailState } from "@/lib/community/server-rail-model"
import { tid } from "@/lib/community/testids"

export function ServerRailDragPreview({ dnd, servers, folderNames, state, activeServerId }: {
  dnd: RailDndController
  servers: ReadonlyMap<string, Server>
  folderNames: ReadonlyMap<string, string>
  state: RailState
  activeServerId: string
}) {
  const { entity, offset, returning } = useServerRailDrag(dnd)
  if (!entity || !offset) return null
  const server = entity.kind === "server" ? servers.get(entity.id) : undefined
  const name = server?.name ?? folderNames.get(entity.id) ?? "Group"
  const children = (state.folders[entity.id] ?? []).flatMap((id) => {
    const child = servers.get(id)
    return child ? [child] : []
  })
  return (
    <DndDragPreview offset={offset} width={44} height={44} returning={returning}
      onReturnComplete={() => { if (returning) dnd.completeReturn(returning) }} anchorClassName="size-11"
      data-testid={tid.serverRailDragPreview} data-rail-floating-preview={entity.kind} data-rail-preview-phase={returning ? "returning" : "dragging"}>
        <span data-slot="community-server-rail-drag-glyph" className="relative grid size-11 place-items-center opacity-50">
          {server ? <RailServerIcon server={server} active={activeServerId === server.id} /> : (
            <span data-slot="community-server-rail-drag-folder" className={`grid size-10 shrink-0 place-items-center bg-accent/50 text-muted-foreground dark:bg-accent ${children.some((child) => child.id === activeServerId) ? "rounded-xl" : "rounded-[18px]"}`}>
              <RailFolderIcon open={false} folderServers={children} />
            </span>
          )}
          {server && server.mentions > 0 && <span data-slot="community-server-rail-drag-mentions" className="absolute -bottom-0.5 -right-0.5 z-2 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground ring-2 ring-(--d-rail)">{server.mentions}</span>}
        </span>
        <span data-slot="community-server-rail-drag-name" data-testid={tid.serverRailDragName} className="absolute left-[calc(100%+8px)] top-1/2 inline-flex w-max max-w-xs -translate-y-1/2 items-center rounded-md bg-foreground px-3 py-2 text-xs text-background">
          <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rotate-45 rounded-xs bg-foreground" />
          <span className="truncate">{name}</span>
        </span>
    </DndDragPreview>
  )
}
