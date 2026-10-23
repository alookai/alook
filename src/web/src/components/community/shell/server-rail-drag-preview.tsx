"use client"

import { createPortal } from "react-dom"
import { useLayoutEffect, useRef } from "react"
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
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!returning || !anchor.current) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    const element = returning.element
    const rect = element.getBoundingClientRect()
    if (!element.isConnected || rect.width === 0 || rect.height === 0 || media.matches) {
      dnd.completeReturn(returning)
      return
    }
    const animation = anchor.current.animate([
      { transform: `translate(${returning.offset.x}px, ${returning.offset.y}px)` },
      { transform: `translate(${rect.left + (rect.width - 44) / 2}px, ${rect.top + (rect.height - 44) / 2}px)` },
    ], { duration: 150, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" })
    const complete = () => dnd.completeReturn(returning)
    animation.onfinish = complete
    const reduce = () => { if (media.matches) complete() }
    media.addEventListener("change", reduce)
    return () => {
      animation.onfinish = null
      animation.cancel()
      media.removeEventListener("change", reduce)
    }
  }, [dnd, returning])
  if (!entity || !offset) return null
  const server = entity.kind === "server" ? servers.get(entity.id) : undefined
  const name = server?.name ?? folderNames.get(entity.id) ?? "Group"
  const children = (state.folders[entity.id] ?? []).flatMap((id) => {
    const child = servers.get(id)
    return child ? [child] : []
  })
  return createPortal(
    <div aria-hidden="true" data-testid={tid.serverRailDragPreview} data-rail-floating-preview={entity.kind} data-rail-preview-phase={returning ? "returning" : "dragging"} className="pointer-events-none fixed inset-0 z-50">
      <div ref={anchor} className="absolute left-0 top-0 grid size-11 place-items-center" style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
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
      </div>
    </div>, document.body,
  )
}
