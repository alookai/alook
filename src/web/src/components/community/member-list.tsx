"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Shield, UserMinus, Check, Search, UserPlus, LogOut } from "lucide-react"
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent,
} from "@/components/ui/context-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Avatar } from "./avatar"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { hasStatus } from "./status-presets"
import { tid } from "@/lib/community/testids"
import type { Member, Role, OpenProfile, MemberManageContext } from "./_types"
import { canManageServer, isServerOwner, ROLES, isPresenceOnline, isPresenceOffline } from "./_types"

const SETTABLE_ROLES: Role[] = ["admin", "member"]

// Fixed row heights used by the virtualizer. Slight over-estimation is safer
// than under — react-virtual will measure real heights afterwards, but the
// initial paint uses this. Group headers are shorter than rows.
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 32

type FlatItem =
  | { kind: "header"; label: string; count: number; key: string }
  | { kind: "row"; member: Member; key: string }

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function groupMembers(members: Member[]): { label: string; list: Member[] }[] {
  const owner = members.filter((m) => isServerOwner(m.role))
  const admin = members.filter((m) => m.role === ROLES.ADMIN)
  const rest = members.filter((m) => m.role === ROLES.MEMBER)
  const online = rest.filter((m) => isPresenceOnline(m.status))
  const offline = rest.filter((m) => isPresenceOffline(m.status))
  return [
    { label: "Owner", list: owner },
    { label: "Admin", list: admin },
    { label: "Online", list: online },
    { label: "Offline", list: offline },
  ].filter((g) => g.list.length > 0)
}

// Same disambiguation convention as the @-mention popover (`rankMentionItems`
// in mention-extension.ts) — a member's name is flagged only when it collides
// (case-insensitively) with another member's name in the same list, so a
// caller can show the `#0042` discriminator solely for ambiguous rows.
// Exported for unit testing without rendering the virtualized list.
export function computeDuplicateNames(members: Member[]): Set<string> {
  const counts = new Map<string, number>()
  for (const m of members) {
    const key = m.name.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [key, count] of counts) if (count >= 2) dupes.add(key)
  return dupes
}

// Flatten grouped members into a single (header|row) stream so the virtualizer
// measures both kinds. Preserves the existing Owner / Admin / Online / Offline
// grouping — sticky headers become one row of the virtual list.
function flattenGroups(members: Member[]): FlatItem[] {
  const items: FlatItem[] = []
  for (const group of groupMembers(members)) {
    items.push({
      kind: "header",
      label: group.label,
      count: group.list.length,
      key: `header:${group.label}`,
    })
    for (const m of group.list) {
      items.push({ kind: "row", member: m, key: `row:${m.id}` })
    }
  }
  return items
}

export function MemberList({
  members,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  onSearch,
  onAddMember,
  manageContext,
  myRole,
  onOpenProfile,
  onSetRole,
  onKick,
}: {
  members: Member[]
  loading?: boolean
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  onSearch?: (q: string) => void
  onAddMember?: () => void
  // When set, rows are a private channel/post roster or a thread's participants:
  // the right-click menu offers "Leave" on the viewer's own row and "Remove" on
  // other explicit members (creator only), instead of the server-scoped
  // Role/Kick menu. Presence of this prop switches the row menu.
  manageContext?: MemberManageContext
  myRole?: Role
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKick?: (name: string) => void
}) {
  const [kickTarget, setKickTarget] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const canManage = canManageServer(myRole)

  // Debounced search — 200ms mirrors the hook's own debounce for consistency
  // (the hook debounces the network call; this debounces the callback fire
  // so we don't spam the hook on every keystroke).
  useEffect(() => {
    if (!onSearch) return
    const t = setTimeout(() => onSearch(query), 200)
    return () => clearTimeout(t)
  }, [query, onSearch])

  const items = useMemo(() => flattenGroups(members), [members])
  const duplicateNames = useMemo(() => computeDuplicateNames(members), [members])
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // TanStack Virtual returns unstable function refs — React Compiler skips memoization.
  // eslint-disable-next-line react-hooks/incompatible-library -- library limitation
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index]?.kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    overscan: 8,
  })

  // Trigger loadMore when the sentinel scrolls into the viewport. Guard on
  // `loadingMore` inside the callback path (the hook also guards internally,
  // but the extra check avoids sending an event when we already know one is
  // in flight).
  useEffect(() => {
    if (!onLoadMore || !hasMore) return
    const el = sentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !loadingMore) onLoadMore()
        }
      },
      { root, rootMargin: "100px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [onLoadMore, hasMore, loadingMore])

  if (loading && members.length === 0 && !query) return <MemberListSkeleton />

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
      <aside className="flex h-full flex-col bg-background">
        {(onSearch || onAddMember) && (
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            {onSearch && (
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-9 pl-8"
                  placeholder="Search members"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
            {onAddMember && (
              <button
                type="button"
                onClick={onAddMember}
                className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label="Add members"
                title="Add members"
              >
                <UserPlus className="size-4" />
              </button>
            )}
          </div>
        )}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
          <div className="px-4 py-4">
            <div
              style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = items[virtualRow.index]
                return (
                  <div
                    key={item.key}
                    role="listitem"
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {item.kind === "header" ? (
                      <h3 className="mb-2 px-1 text-xs font-medium text-muted-foreground">
                        {item.label} — {item.count}
                      </h3>
                    ) : (
                      <MemberRow
                        mem={item.member}
                        canManage={canManage}
                        showDiscriminator={duplicateNames.has(item.member.name.toLowerCase())}
                        onOpenProfile={onOpenProfile}
                        onSetRole={onSetRole}
                        onKick={setKickTarget}
                        manageContext={manageContext}
                      />
                    )}
                  </div>
                )
              })}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="py-3 text-center text-xs text-muted-foreground">
                {loadingMore ? "Loading…" : ""}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}

// True when the row has at least one right-click action (role change / kick). Owners
// can't be managed, so their row — and any row for a non-manager — skips the ContextMenu
// wrapper rather than opening an empty popover strip.
export function hasMemberMenu(canManage: boolean, role: Role) {
  return canManage && role !== "owner"
}

function MemberRow({
  mem,
  canManage,
  showDiscriminator,
  onOpenProfile,
  onSetRole,
  onKick,
  manageContext,
}: {
  mem: Member
  canManage: boolean
  // True when another member currently in the list shares this name
  // (case-insensitive) — mirrors the @-mention popover's disambiguation
  // rule (see `rankMentionItems`) so the two surfaces agree on when a
  // `#0042` discriminator is worth showing.
  showDiscriminator: boolean
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKick: (name: string) => void
  manageContext?: MemberManageContext
}) {
  const button = (
    <button
      data-testid={tid.memberRow(mem.userId)}
      onClick={(e) => onOpenProfile?.(mem.name, e, undefined, mem.userId)}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2 select-none hover:bg-accent"
    >
      <Avatar label={mem.avatar} seed={mem.userId} size={32} presence={mem.status} dim={isPresenceOffline(mem.status)} />
      <div className="min-w-0 flex-1 space-y-0.5 text-left">
        <div className={`truncate text-sm leading-tight ${isPresenceOffline(mem.status) ? "text-muted-foreground" : ""}`}>
          {mem.name}
          {showDiscriminator && mem.discriminator && (
            <span className="text-muted-foreground">#{mem.discriminator}</span>
          )}
        </div>
        {hasStatus(mem.statusEmoji, mem.statusText) && (
          <div className="truncate text-xs leading-tight text-muted-foreground">{mem.statusEmoji} {mem.statusText}</div>
        )}
      </div>
    </button>
  )

  // Private channel/post roster or thread participant row: Leave (self) /
  // Remove (unit creator on other explicit members). Replaces the server-scoped
  // Role/Kick menu — eviction here is unit membership/participation, not a
  // server kick. Remove is creator-only (admins have no content privilege); the
  // creator's own row is locked (no Leave, never removable).
  if (manageContext) {
    const isSelf = mem.userId === manageContext.viewerUserId
    // Self may leave unless they're the creator (owners keep the unit).
    const canLeave = isSelf && !mem.isCreator
    // Creator may remove other EXPLICIT members, but never the creator row.
    // `source` is undefined for thread participants (all real rows) → treat as
    // removable; for channel/post only explicit rows are removable.
    const canRemove =
      !isSelf &&
      manageContext.viewerIsCreator &&
      !mem.isCreator &&
      (mem.source === undefined || mem.source === "explicit")
    if (!canLeave && !canRemove) return button
    return (
      <ContextMenu>
        <ContextMenuTrigger render={button} />
        <ContextMenuContent className="w-48">
          <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{mem.name}</div>
          {canLeave ? (
            <ContextMenuItem onClick={() => manageContext.onLeave(mem.userId)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">
              <LogOut className="size-4" /> Leave
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onClick={() => manageContext.onRemove(mem.userId)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">
              <UserMinus className="size-4" /> Remove {mem.name}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  if (!hasMemberMenu(canManage, mem.role)) return button
  return (
    <ContextMenu>
      <ContextMenuTrigger render={button} />
      <ContextMenuContent className="w-48">
        <div className="truncate px-2 py-1 text-xs font-semibold text-muted-foreground">{mem.name}</div>
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
        <ContextMenuItem onClick={() => onKick(mem.name)} className="text-destructive data-highlighted:bg-destructive/10 data-highlighted:text-destructive">
          <UserMinus className="size-4" /> Kick {mem.name}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
      <div className="px-4 py-4">
        {groups.map((g, i) => (
          <div key={i} className="mb-4">
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
