"use client"

import { useState } from "react"
import { Shield, UserMinus, Check } from "lucide-react"
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu"
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

export function MemberList({ members, myRole, onOpenProfile, onSetRole, onKick }: {
  members: Member[]
  myRole?: Role
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKick?: (name: string) => void
}) {
  const [kickTarget, setKickTarget] = useState<string | null>(null)
  const canManage = canManageServer(myRole)
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
