"use client"

import { useState } from "react"
import { Plus, ChevronDown } from "lucide-react"
import { CreateServerDialog } from "./create-server-dialog"
import type { Server, CommunityFolder, View } from "./_types"

export function MobileRail({
  servers, folders, onPick, onHome, onServer, onServerNavigate, onAddServer, onJoinServer, view,
}: {
  servers: Server[]
  folders: CommunityFolder[]
  onPick: () => void
  onHome: () => void
  onServer: () => void
  onServerNavigate?: (id: string) => void
  onAddServer?: (name: string) => void
  onJoinServer?: () => void
  view: View
}) {
  const [folderOpen, setFolderOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto thin-scrollbar bg-card p-3">
      <button onClick={onHome} className={`mb-1 flex items-center gap-3 rounded-lg p-2 ${view === "dm" ? "bg-accent" : "hover:bg-accent"}`}>
        <span className="grid size-10 shrink-0 place-items-center">
          <img src="/alook.svg" alt="" className="size-8 dark:hidden" />
          <img src="/alook-dark.svg" alt="" className="hidden size-8 dark:block" />
        </span>
        <span className="text-sm font-medium text-muted-foreground">Direct Messages</span>
      </button>
      <div className="my-2 h-px w-full bg-border" />
      {servers.map((s) => (
        <button key={s.id} onClick={() => { onServer(); onServerNavigate?.(s.id); onPick() }} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
          <span className={[
            "grid size-10 shrink-0 place-items-center overflow-hidden rounded-[18px] text-sm font-semibold",
            view !== "dm" && s.active ? "bg-primary text-primary-foreground" : "bg-card",
          ].join(" ")}>
            {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : s.initial}
          </span>
          <span className="flex-1 text-left text-sm font-medium">{s.name}</span>
          {s.unread && <span className="size-2 rounded-full bg-primary" />}
        </button>
      ))}

      {folders.map((folder) => (
        <div key={folder.id}>
          <button onClick={() => setFolderOpen((v) => !v)} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
            <span className={`grid size-10 shrink-0 grid-cols-2 gap-0.5 p-1.5 ${folderOpen ? "rounded-xl bg-primary/15" : "rounded-[18px] bg-accent"}`}>
              {folder.servers.slice(0, 4).map((s) => (
                <span key={s.id} className="grid place-items-center overflow-hidden rounded-lg bg-card text-[7px] font-semibold text-muted-foreground">
                  {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : s.initial}
                </span>
              ))}
            </span>
            <span className="flex-1 text-left text-sm font-medium">{folder.name}</span>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${folderOpen ? "" : "-rotate-90"}`} />
          </button>
          {folderOpen && (
            <div className="ml-3 flex flex-col gap-1 border-l border-border pl-3">
              {folder.servers.map((s) => (
                <button key={s.id} onClick={() => { onServer(); onServerNavigate?.(s.id); onPick() }} className="flex items-center gap-3 rounded-lg p-2 hover:bg-accent">
                  <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-[18px] bg-card text-sm font-semibold">
                    {s.icon ? <img src={s.icon} alt={s.name} className="size-full object-cover" /> : s.initial}
                  </span>
                  <span className="flex-1 text-left text-sm font-medium">{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <button onClick={() => setCreateOpen(true)} className="mt-1 flex items-center gap-3 rounded-lg p-2 text-primary hover:bg-accent">
        <span className="grid size-10 shrink-0 place-items-center rounded-[18px] bg-card"><Plus className="size-6" /></span>
        <span className="text-sm font-medium">Add a Server</span>
      </button>

      {createOpen && (
        <CreateServerDialog
          onClose={() => setCreateOpen(false)}
          onCreateServer={(name) => { onAddServer?.(name); setCreateOpen(false) }}
          onJoinServer={() => { onJoinServer?.(); setCreateOpen(false) }}
        />
      )}
    </div>
  )
}
