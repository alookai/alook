import { Shield, UserMinus, Check } from "lucide-react"
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/context-menu"
import { Avatar } from "./avatar"
import type { Member, Role, OpenProfile } from "./_types"

// Settable roles via the menu — Owner is excluded (only the server creator is Owner,
// and it can't be reassigned through the UI).
const SETTABLE_ROLES: Role[] = ["Admin", "Member"]

// Discord-style grouping: hoisted role groups first (Owner, Admin), then the remaining
// members split by presence (Online / Offline). Empty groups are dropped.
function groupMembers(members: Member[]): { label: string; list: Member[] }[] {
  const owner = members.filter((m) => m.role === "Owner")
  const admin = members.filter((m) => m.role === "Admin")
  const rest = members.filter((m) => m.role === "Member")
  const online = rest.filter((m) => m.status === "online")
  const offline = rest.filter((m) => m.status === "offline")
  return [
    { label: "Owner", list: owner },
    { label: "Admin", list: admin },
    { label: "Online", list: online },
    { label: "Offline", list: offline },
  ].filter((g) => g.list.length > 0)
}

// Member list. Right-click a member to change their role (single-select) or kick them.
export function MemberList({ members, onOpenProfile, onSetRole, onKick }: {
  members: Member[]
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKick?: (name: string) => void
}) {
  return (
    <aside className="flex h-full flex-col overflow-y-auto thin-scrollbar bg-background">
      <div className="px-3 py-4">
        {groupMembers(members).map((group) => (
          <div key={group.label} className="mb-4">
            <h3 className="mb-1 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.label} — {group.list.length}
            </h3>
            {group.list.map((mem) => (
              <ContextMenu key={mem.name}>
                <ContextMenuTrigger
                  render={
                    <button
                      onClick={(e) => onOpenProfile?.(mem.name, e)}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent"
                      style={{ opacity: mem.status === "offline" ? 0.4 : 1 }}
                    />
                  }
                >
                  <Avatar label={mem.avatar} size={32} presence={mem.status} />
                  <div className="min-w-0 flex-1 text-left">
                    <div className="truncate text-[15px] leading-tight">{mem.name}</div>
                    {mem.sub && (
                      <div className="truncate text-xs leading-tight text-muted-foreground">{mem.sub}</div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{mem.name}</div>
                  <div className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground"><Shield className="size-3.5" /> Role</div>
                  {mem.role === "Owner" ? (
                    <ContextMenuItem disabled>Owner</ContextMenuItem>
                  ) : (
                    SETTABLE_ROLES.map((r) => (
                      <ContextMenuItem key={r} onClick={() => onSetRole?.(mem.name, r)}>
                        <span className="flex-1">{r}</span>
                        {mem.role === r && <Check className="size-4" />}
                      </ContextMenuItem>
                    ))
                  )}
                  {mem.role !== "Owner" && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem onClick={() => onKick?.(mem.name)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">
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
  )
}
