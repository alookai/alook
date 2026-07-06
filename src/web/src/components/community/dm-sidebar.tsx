"use client"

import { memo } from "react"
import { Users, Ban, Monitor, Bot } from "lucide-react"
import { Avatar } from "./avatar"
import { Skeleton } from "@/components/ui/skeleton"
import type { DM } from "./_types"

export const DmSidebar = memo(function DmSidebar({
  dms, activeDm, blockedUserIds, loading, onPickDm, onShowFriends, onShowMachines, onShowBots,
  friendsActive, machinesActive, botsActive,
}: {
  dms: DM[]
  activeDm: string | null
  blockedUserIds?: Set<string>
  loading?: boolean
  onPickDm: (id: string) => void
  onShowFriends: () => void
  onShowMachines?: () => void
  onShowBots?: () => void
  friendsActive?: boolean
  machinesActive?: boolean
  botsActive?: boolean
}) {
  if (loading && dms.length === 0) return <DmSidebarSkeleton />
  const isFriendsActive = friendsActive ?? (activeDm === null && !machinesActive && !botsActive)
  return (
    <aside className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto thin-scrollbar px-2 py-4">
        <button
          onClick={onShowFriends}
          className={[
            "mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-medium",
            isFriendsActive ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          ].join(" ")}
        >
          <Users className="size-5" /> Friends
        </button>
        {onShowMachines && (
          <button
            onClick={onShowMachines}
            className={[
              "mb-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-medium",
              machinesActive ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            ].join(" ")}
          >
            <Monitor className="size-5" /> Machines
          </button>
        )}
        {onShowBots && (
          <button
            onClick={onShowBots}
            className={[
              "mb-2 flex h-9 w-full items-center gap-2 rounded-md px-2 text-sm font-medium",
              botsActive ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            ].join(" ")}
          >
            <Bot className="size-5" /> My Bots
          </button>
        )}
        <div className="my-2 h-px bg-border" />
        <div className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
                "flex w-full items-center gap-3 rounded-md px-2 py-2",
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
})

// Loading placeholder for the DM sidebar — mirrors the Friends button + DM
// row footprint so the column doesn't reflow when conversations arrive.
function DmSidebarSkeleton() {
  return (
    <aside className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-hidden px-2 py-4">
        <Skeleton className="mb-2 h-9 w-full rounded-md" />
        <div className="my-2 h-px bg-border" />
        <div className="mb-2 px-2">
          <Skeleton className="h-3 w-32 rounded" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className="h-3.5 w-3/5 rounded" />
              <Skeleton className="h-3 w-4/5 rounded" />
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
