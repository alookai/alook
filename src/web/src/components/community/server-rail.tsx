"use client"

import { useState } from "react"
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
  servers, folderServers, setMobileZone, view, onHome, onServer, onCreateServer, onJoinServer, onLeaveServer,
}: {
  servers: Server[]
  folderServers: FolderServer[]
  setMobileZone?: (z: MobileZone) => void
  view: View
  onHome: () => void
  onServer: () => void
  onCreateServer?: (name: string) => void
  onJoinServer?: (invite: string) => void
  onLeaveServer?: (id: string) => void
}) {
  const { order, folderOpen, setFolderOpen, onDragStart, onDragEnd, appendServer } = useRailOrder(servers.map((s) => s.id))
  const [serverList, setServerList] = useState<Server[]>(servers)
  const [activeId, setActiveId] = useState(servers.find((s) => s.active)?.id ?? servers[0].id)
  const [createOpen, setCreateOpen] = useState(false)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // selecting a server: mark it active locally + switch into server view
  const pickServer = (id: string) => { setActiveId(id); onServer(); setMobileZone?.("channels") }
  const byId = (id: string) => serverList.find((s) => s.id === id)

  // add a server to the rail and select it (live app: POST then navigate)
  let railSeq = serverList.length
  const addServer = (name: string) => {
    const id = `sv_local_${++railSeq}`
    const initial = (name.trim()[0] ?? "S").toUpperCase()
    setServerList((prev) => [...prev, { id, name: name.trim() || "New Server", initial, active: false, unread: false, mentions: 0 }])
    appendServer(id)
    setActiveId(id)
  }
  return (
    <nav className="flex w-18 shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-clip thin-scrollbar">
      {/* @me / Direct Messages home */}
      <RailIcon
        active={view === "dm"}
        onClick={onHome}
        tooltip="Direct Messages"
        label={
          <>
            <img src="/alook.svg" alt="Alook" className="size-6 dark:hidden" />
            <img src="/alook-dark.svg" alt="Alook" className="hidden size-6 dark:block" />
          </>
        }
        round
      />
      <div className="my-1 h-px w-8 bg-border" />
      <DndContext id="d-rail" sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          <div className="flex w-full flex-col items-center gap-2">
            {order.map((id) => {
              if (id === FOLDER_ID)
                return (
                  <RailFolder
                    key={id}
                    open={folderOpen}
                    onToggle={() => setFolderOpen((v) => !v)}
                    activeId={activeId}
                    onSelect={pickServer}
                    setMobileZone={setMobileZone}
                    folderServers={folderServers}
                  />
                )
              const s = byId(id)!
              return (
                <SortableServer
                  key={id}
                  server={s}
                  active={view !== "dm" && activeId === id}
                  onClick={() => pickServer(id)}
                  onLeave={() => onLeaveServer?.(id)}
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
          onCreateServer={(name) => { addServer(name); onCreateServer?.(name) }}
          onJoinServer={(invite) => { addServer("New Server"); onJoinServer?.(invite) }}
        />
      )}
    </nav>
  )
}
