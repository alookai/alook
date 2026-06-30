"use client"

import { useState } from "react"
import { Shield, UserMinus, Check } from "lucide-react"
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import type { Member, Role, OpenProfile } from "./_types"
import { canManageServer } from "./_types"

const SETTABLE_ROLES: Role[] = ["admin", "member"]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function groupMembers(members: Member[]): { label: string; list: Member[] }[] {
  const owner = members.filter((m) => m.role === "owner")
  const admin = members.filter((m) => m.role === "admin")
  const rest = members.filter((m) => m.role === "member")
  const online = rest.filter((m) => m.status === "online")
  const offline = rest.filter((m) => m.status === "offline")
  return [
    { label: "Owner", list: owner },
    { label: "Admin", list: admin },
    { label: "Online", list: online },
    { label: "Offline", list: offline },
  ].filter((g) => g.list.length > 0)
}

export function MemberList({ members, loading, myRole, onOpenProfile, onSetRole, onKick }: {
  members: Member[]
  loading?: boolean
  myRole?: Role
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKick?: (name: string) => void
}) {
  const [kickTarget, setKickTarget] = useState<string | null>(null)
  const canManage = canManageServer(myRole)
  if (loading && members.length === 0) return <MemberListSkeleton />
  return (
    <>
    <ConfirmDialog
      open={!!kickTarget}
      onOpenChange={(o) => { if (!o) setKickTarget(null) }}
      title={`Kick ${kickTarget}?`}
      description="They will be removed from this server but can rejoin with an invite."
      confirmLabel="Kick"
      confirmVariant="destructive"
      onConfirm={() => { if (kickTarget) onKick?.(kickTarget); setKickTarget(null) }}
    />
    <aside className="flex h-full flex-col overflow-y-auto thin-scrollbar bg-background">
      <div className="px-3 py-5">
        {groupMembers(members).map((group) => (
          <div key={group.label} className="mb-5">
            <h3 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label} — {group.list.length}
            </h3>
            {group.list.map((mem) => (
              <ContextMenu key={mem.name}>
                <ContextMenuTrigger
                  render={
                    <button
                      onClick={(e) => onOpenProfile?.(mem.name, e)}
                      className="flex w-full items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
                    />
                  }
                >
                  <Avatar label={mem.avatar} size={32} presence={mem.status} dim={mem.status === "offline"} />
                  <div className="min-w-0 flex-1 text-left">
                    <div className={`truncate text-sm leading-tight ${mem.status === "offline" ? "text-muted-foreground" : ""}`}>{mem.name}</div>
                    {mem.sub && (
                      <div className="truncate text-xs leading-tight text-muted-foreground">{mem.sub}</div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{mem.name}</div>
                  {canManage && mem.role !== "owner" && (
                    <>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger>
                          <Shield className="size-4" />
                          Role
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          {SETTABLE_ROLES.map((r) => (
                            <ContextMenuItem key={r} onClick={() => onSetRole?.(mem.name, r)}>
                              <span className="flex-1">{capitalize(r)}</span>
                              {mem.role === r && <Check className="size-4" />}
                            </ContextMenuItem>
                          ))}
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => setKickTarget(mem.name)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">
                        <UserMinus className="size-4" /> Kick {mem.name}
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        ))}
      </div>
    </aside>
    </>
  )
}

// Loading placeholder for the right-panel Members list — reserves space for
// two role groups + a body of online members, matching <MemberList>'s grouping.
function MemberListSkeleton() {
  const groups: { width: number; rows: number }[] = [
    { width: 60, rows: 1 },
    { width: 60, rows: 2 },
    { width: 60, rows: 6 },
  ]
  return (
    <aside className="flex h-full flex-col overflow-hidden bg-background">
      <div className="px-3 py-5">
        {groups.map((g, i) => (
          <div key={i} className="mb-5">
            <Skeleton className="mb-2 ml-1 h-3 rounded" style={{ width: g.width }} />
            <div className="space-y-1">
              {Array.from({ length: g.rows }).map((_, j) => (
                <div key={j} className="flex items-center gap-3 rounded-md px-2 py-2">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <Skeleton className="h-3.5 w-3/5 rounded" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
