"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Plus } from "lucide-react"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragOverlay,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import { RailIcon } from "./rail-icon"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { SortableServer } from "./sortable-server"
import { RailFolder } from "./rail-folder"
import { CreateServerDialog } from "./create-server-dialog"
import { useRailOrder, isFolderKey, extractFolderId, folderId } from "./use-rail-order"
import type { Server, CommunityFolder, MobileZone, View } from "./_types"

export function ServerRail({
  servers, folders, activeServerId: activeServerIdProp, serversLoading, setMobileZone, view, bottomInset,
  onHome, onServer, onServerNavigate, onCreateServer, onJoinServer, onLeaveServer,
  onOpenSettings, onUngroupFolder, onReorderRail, onReorderFolders, onFolderItemsChange, onDragCreateFolder,
}: {
  servers: Server[]
  folders: CommunityFolder[]
  activeServerId?: string
  serversLoading?: boolean
  setMobileZone?: (z: MobileZone) => void
  view: View
  bottomInset?: number
  onHome: () => void
  onServer: () => void
  onServerNavigate?: (id: string) => void
  onCreateServer?: (name: string, icon?: File) => void
  onJoinServer?: (invite: string) => void
  onLeaveServer?: (id: string) => void
  onOpenSettings?: (serverId: string) => void
  onUngroupFolder?: (folderId: string) => void
  onReorderRail?: (serverIds: string[]) => void
  onReorderFolders?: (folderIds: string[]) => void
  onFolderItemsChange?: (folderId: string, serverIds: string[]) => void
  onDragCreateFolder?: (serverIdA: string, serverIdB: string) => void
}) {
  const railIds = useMemo(() => servers.map((s) => s.id), [servers])

  const {
    visibleItems, sortableIds, openFolders, toggleFolder, folderOrders,
    onDragStart: hookDragStart, onDragOver, onDragEnd: hookDragEnd, groupTarget,
  } = useRailOrder(railIds, folders, {
    onReorderRail, onReorderFolders, onFolderItemsChange, onCreateFolder: onDragCreateFolder,
  })

  const [dragActiveId, setDragActiveId] = useState<string | null>(null)
  const onDragStart = (e: Parameters<typeof hookDragStart>[0]) => {
    setDragActiveId(String(e.active.id))
    hookDragStart(e)
  }
  const onDragEnd = (e: Parameters<typeof hookDragEnd>[0]) => {
    hookDragEnd(e)
    setDragActiveId(null)
  }

  const activeFromProps = activeServerIdProp ?? servers.find((s) => s.active)?.id ?? ""
  const [activeId, setActiveId] = useState(activeFromProps)
  useEffect(() => { if (activeFromProps) setActiveId(activeFromProps) }, [activeFromProps])

  const [createOpen, setCreateOpen] = useState(false)
  const [didAutoOpen, setDidAutoOpen] = useState(false)
  useEffect(() => {
    if (!didAutoOpen && servers.length === 0 && folders.length === 0 && serversLoading === false) {
      setDidAutoOpen(true)
      setCreateOpen(true)
    }
  }, [servers.length, folders.length, serversLoading, didAutoOpen])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const pickServer = (id: string) => { setActiveId(id); onServer(); onServerNavigate?.(id); setMobileZone?.("channels") }

  const serverById = useMemo(() => new Map(servers.map((s) => [s.id, s])), [servers])
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders])
  // All servers in folders (for lookup by id)
  const folderServerMap = useMemo(() => {
    const m = new Map<string, { id: string; name: string; initial: string; icon: string | null }>()
    for (const f of folders) for (const s of f.servers) m.set(s.id, { id: s.id, name: s.name, initial: s.initial, icon: s.icon ?? null })
    return m
  }, [folders])

  return (
    <nav aria-label="Server navigation" className="flex w-14 shrink-0 flex-col items-center gap-1.5 pt-1 pb-2 overflow-y-auto overflow-x-clip thin-scrollbar" style={bottomInset ? { paddingBottom: bottomInset } : undefined}>
      <Tooltip>
        <TooltipTrigger render={<div className="group relative flex w-full justify-center" />}>
          <span className={[
            "absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all duration-150",
            view === "dm" ? "h-8" : "h-0 group-hover:h-5",
          ].join(" ")} />
          <button
            onClick={onHome}
            className="grid size-10 shrink-0 place-items-center rounded-[20px] transition-all duration-150 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <img src="/alook.svg" alt="Alook" className="size-8 dark:hidden" />
            <img src="/alook-dark.svg" alt="Alook" className="hidden size-8 dark:block" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>Direct Messages</TooltipContent>
      </Tooltip>
      <div className="w-6 border-t border-border/50 my-1" />
      <DndContext id="d-rail" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={() => setDragActiveId(null)}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="flex w-full flex-col items-center gap-2">
            {(() => {
              const elements: ReactNode[] = []
              let i = 0
              while (i < visibleItems.length) {
                const id = visibleItems[i]!

                if (isFolderKey(id)) {
                  const fId = extractFolderId(id)
                  const folder = folderById.get(fId)
                  if (!folder) { i++; continue }
                  const isOpen = openFolders.has(fId)

                  elements.push(
                    <RailFolder
                      key={id}
                      folderId={fId}
                      sortableId={id}
                      open={isOpen}
                      onToggle={() => toggleFolder(fId)}
                      activeId={activeId}
                      folderServers={folder.servers}
                      onUngroup={() => onUngroupFolder?.(fId)}
                      dragging={dragActiveId === id}
                    />
                  )

                  // Collect open folder's servers
                  if (isOpen) {
                    const folderItems: ReactNode[] = []
                    let j = i + 1
                    while (j < visibleItems.length && !isFolderKey(visibleItems[j]!) && folderServerMap.has(visibleItems[j]!)) {
                      const sid = visibleItems[j]!
                      const fs = folderServerMap.get(sid)!
                      folderItems.push(
                        <SortableServer
                          key={sid}
                          server={{ id: fs.id, name: fs.name, initial: fs.initial, icon: fs.icon, active: false, unread: false, mentions: 0, isOwner: false }}
                          active={view !== "dm" && activeId === sid}
                          onClick={() => pickServer(sid)}
                          inFolder
                          dragging={dragActiveId === sid}
                        />
                      )
                      j++
                    }
                    if (folderItems.length > 0) {
                      elements.push(
                        <div key={`fi-${fId}`} className="relative flex w-full flex-col items-center gap-2 py-1">
                          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-12 -translate-x-1/2 rounded-[20px] bg-primary/10" />
                          {folderItems}
                        </div>
                      )
                    }
                    i = j
                  } else {
                    i++
                  }
                } else {
                  // Rail server
                  const s = serverById.get(id)
                  if (s) {
                    elements.push(
                      <SortableServer
                        key={id}
                        server={s}
                        active={view !== "dm" && s.active}
                        onClick={() => pickServer(id)}
                        onLeave={() => onLeaveServer?.(id)}
                        onOpenSettings={() => onOpenSettings?.(id)}
                        onCreateFolder={folders.length < 10 ? () => onDragCreateFolder?.(id, id) : undefined}
                        groupTarget={groupTarget === id}
                        dragging={dragActiveId === id}
                      />
                    )
                  }
                  i++
                }
              }
              return elements
            })()}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {dragActiveId && (() => {
            if (isFolderKey(dragActiveId)) {
              const fId = extractFolderId(dragActiveId)
              const folder = folderById.get(fId)
              if (!folder) return null
              return (
                <div className="grid size-10 grid-cols-2 gap-0.5 rounded-xl bg-accent p-1.5 shadow-[var(--e2)]">
                  {Array.from({ length: 4 }).map((_, idx) => {
                    const s = folder.servers[idx]
                    return s ? (
                      <span key={s.id} className="grid aspect-square place-items-center overflow-hidden rounded-sm bg-card text-[7px] font-semibold text-muted-foreground">
                        {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : s.initial}
                      </span>
                    ) : (
                      <span key={idx} className="aspect-square rounded-sm bg-card/50" />
                    )
                  })}
                </div>
              )
            }
            const s = serverById.get(dragActiveId) ?? folderServerMap.get(dragActiveId)
            if (!s) return null
            return (
              <div className="grid size-10 place-items-center overflow-hidden rounded-xl bg-secondary text-sm font-semibold text-foreground shadow-[var(--e2)]">
                {"icon" in s && s.icon ? (
                  <img src={s.icon} alt={s.name} className="size-full object-cover" />
                ) : (
                  s.initial
                )}
              </div>
            )
          })()}
        </DragOverlay>
      </DndContext>
      <RailIcon label={<Plus className="size-6" />} round accent tooltip="Add a Server" onClick={() => setCreateOpen(true)} />

      {createOpen && (
        <CreateServerDialog
          onClose={() => setCreateOpen(false)}
          onCreateServer={(name, icon) => { onCreateServer?.(name, icon) }}
          onJoinServer={(invite) => { onJoinServer?.(invite) }}
        />
      )}
    </nav>
  )
}
