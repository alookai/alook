"use client"

import { Users, Ban } from "lucide-react"
import { Avatar } from "./avatar"
import type { DM } from "./_types"

export function DmSidebar({
  dms, activeDm, blockedUserIds, onPickDm, onShowFriends,
}: {
  dms: DM[]
  activeDm: string | null
  blockedUserIds?: Set<string>
  onPickDm: (id: string) => void
  onShowFriends: () => void
}) {
  return (
    <aside className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2.5 py-4">
        <button
          onClick={onShowFriends}
          className={[
            "mb-2 flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-sm font-medium",
            activeDm === null ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          ].join(" ")}
        >
          <Users className="size-5" /> Friends
        </button>
        <div className="my-2 h-px bg-border" />
        <div className="mb-2 px-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Direct Messages
        </div>
        {dms.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">Your direct messages will appear here.</p>
        )}
        {dms.map((d) => {
          const active = d.id === activeDm
          const isBlocked = blockedUserIds?.has(d.userId)
          return (
            <button
              key={d.id}
              onClick={() => onPickDm(d.id)}
              className={[
                "flex w-full items-center gap-3 rounded-md px-2.5 py-2",
                active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              ].join(" ")}
            >
              <Avatar label={d.avatar} size={32} presence={isBlocked ? undefined : d.status} />
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-sm leading-tight text-foreground">{d.name}</div>
                <div className="truncate text-xs leading-tight text-muted-foreground">{d.preview}</div>
              </div>
              {isBlocked && <Ban className="size-4 shrink-0 text-destructive" />}
              {!isBlocked && d.unread && <span className="size-2 shrink-0 rounded-full bg-primary" />}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
