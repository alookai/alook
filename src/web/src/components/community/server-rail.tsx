"use client"

import { useEffect, useState } from "react"
import { Plus } from "lucide-react"
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core"
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import { RailIcon } from "./rail-icon"
import { SortableServer } from "./sortable-server"
import { RailFolder } from "./rail-folder"
import { CreateServerDialog } from "./create-server-dialog"
import { useRailOrder, FOLDER_ID } from "./use-rail-order"
import type { Server, FolderServer, MobileZone, View } from "./_types"

// The 72px server rail (desktop/tablet). Reorder lives in useRailOrder; this owns the
// active-server selection and the create-server dialog.
export function ServerRail({
  servers, folderServers, serversLoading, setMobileZone, view, onHome, onServer, onServerNavigate, onCreateServer, onJoinServer, onLeaveServer, onOpenSettings, onCreateFolder, onUngroupFolder,
}: {
  servers: Server[]
  folderServers: FolderServer[]
  serversLoading?: boolean
  setMobileZone?: (z: MobileZone) => void
  view: View
  onHome: () => void
  onServer: () => void
  onServerNavigate?: (id: string) => void
  onCreateServer?: (name: string, icon?: File) => void
  onJoinServer?: (invite: string) => void
  onLeaveServer?: (id: string) => void
  onOpenSettings?: (serverId: string) => void
  onCreateFolder?: (serverId: string) => void
  onUngroupFolder?: () => void
}) {
  const { order, folderOpen, setFolderOpen, onDragStart, onDragEnd, appendServer } = useRailOrder(servers.map((s) => s.id))
  const activeFromProps = servers.find((s) => s.active)?.id ?? ""
  const [activeId, setActiveId] = useState(activeFromProps)
  useEffect(() => {
    if (activeFromProps && activeFromProps !== activeId) setActiveId(activeFromProps)
  }, [activeFromProps]) // eslint-disable-line react-hooks/exhaustive-deps
  const [createOpen, setCreateOpen] = useState(false)
  const [didAutoOpen, setDidAutoOpen] = useState(false)
  useEffect(() => {
    // Auto-open create dialog only once, after servers have loaded and list is empty
    if (!didAutoOpen && servers.length === 0 && serversLoading === false) {
      setDidAutoOpen(true)
      setCreateOpen(true)
    }
  }, [servers.length, serversLoading, didAutoOpen])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const pickServer = (id: string) => { setActiveId(id); onServer(); onServerNavigate?.(id); setMobileZone?.("channels") }
  const byId = (id: string) => servers.find((s) => s.id === id)

  return (
    <nav className="flex w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-clip thin-scrollbar">
      {/* @me / Direct Messages home */}
      <RailIcon
        active={view === "dm"}
        onClick={onHome}
        tooltip="Direct Messages"
        label={
          <>
            <img src="/alook.svg" alt="Alook" className="size-full p-1.5 dark:hidden" />
            <img src="/alook-dark.svg" alt="Alook" className="hidden size-full p-1.5 dark:block" />
          </>
        }
        round
      />
      <div className="my-1 h-px w-8 bg-border" />
      <DndContext id="d-rail" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="flex w-full flex-col items-center gap-2">
            {order.map((id) => {
              if (id === FOLDER_ID) {
                if (!folderServers.length) return null
                return (
                  <RailFolder
                    key={id}
                    open={folderOpen}
                    onToggle={() => setFolderOpen((v) => !v)}
                    activeId={activeId}
                    onSelect={pickServer}
                    setMobileZone={setMobileZone}
                    folderServers={folderServers}
                    onUngroup={() => onUngroupFolder?.()}
                  />
                )
              }
              const s = byId(id)
              if (!s) return null
              return (
                <SortableServer
                  key={id}
                  server={s}
                  active={view !== "dm" && s.active}
                  onClick={() => pickServer(id)}
                  onLeave={() => onLeaveServer?.(id)}
                  onOpenSettings={() => onOpenSettings?.(id)}
                  onCreateFolder={() => onCreateFolder?.(id)}
                />
              )
            })}
          </div>
        </SortableContext>
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
