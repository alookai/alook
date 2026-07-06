"use client"

import { useEffect, useRef, useState } from "react"
import type { LucideIcon } from "lucide-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Settings, Users, Link2, Bell, ScrollText, Trash2, X, Shield, Search } from "lucide-react"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Button } from "@/components/ui/button"
import { formatMessageTime, formatRelativeTime } from "./format-time"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { Field } from "./field"
import type { SettingsSection, Member, Role, InviteRow, AuditEntry, OpenProfile } from "./_types"

const SETTABLE_ROLES: Role[] = ["admin", "member"]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Full-screen server settings view. Data via props.
export function ServerSettings({
  section, setSection, onClose, serverName, serverDescription, serverIcon,
  members, membersLoading, membersLoadingMore, membersHasMore, membersTotal, onLoadMoreMembers, onSearchMembers,
  invites, invitesLoading, auditLog, auditLogLoading, onOpenProfile,
  onKickMember, onSetRole, onRevokeInvite, onCopyInvite, onDeleteServer, onUploadIcon, onUpdateServer, notifLevel, onSetNotifLevel,
}: {
  section: SettingsSection
  setSection: (s: SettingsSection) => void
  onClose: () => void
  serverName: string
  serverDescription?: string
  serverIcon?: string | null
  members: Member[]
  membersLoading?: boolean
  membersLoadingMore?: boolean
  membersHasMore?: boolean
  membersTotal?: number
  onLoadMoreMembers?: () => void
  onSearchMembers?: (q: string) => void
  invites: InviteRow[]
  invitesLoading?: boolean
  auditLog: AuditEntry[]
  auditLogLoading?: boolean
  onOpenProfile?: OpenProfile
  onKickMember?: (name: string) => void
  onSetRole?: (name: string, role: Role) => void
  onRevokeInvite?: (code: string) => void
  onCopyInvite?: (code: string) => void
  onDeleteServer?: () => void
  onUploadIcon?: () => void
  onUpdateServer?: (name: string, desc: string) => void
  notifLevel?: string
  onSetNotifLevel?: (l: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const nav: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
    { id: "overview", label: "Overview", icon: Settings },
    { id: "members", label: "Members", icon: Users },
    { id: "invites", label: "Invites", icon: Link2 },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "audit", label: "Audit Log", icon: ScrollText },
  ]
  return (
    <>
    <ConfirmDialog
      open={confirmDelete}
      onOpenChange={setConfirmDelete}
      title={`Delete "${serverName}"?`}
      description="This cannot be undone. All channels, messages, and members will be permanently removed."
      confirmLabel="Delete Server"
      confirmVariant="destructive"
      onConfirm={() => { setConfirmDelete(false); onDeleteServer?.() }}
    />
    <Tabs
      orientation="vertical"
      value={section}
      onValueChange={(v) => setSection(v as SettingsSection)}
      className="min-h-0 flex-1 flex-row gap-0"
    >
      {/* settings nav */}
      <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar border-r border-border p-4" style={{ background: "var(--d-rail)" }}>
        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{serverName}</div>
        <TabsList variant="line" className="h-auto w-full flex-col gap-1">
          {nav.map((n) => (
            <TabsTrigger key={n.id} value={n.id} className="h-9 w-full justify-start gap-2">
              <n.icon className="size-4" /> {n.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Separator className="my-1" />
        <Button variant="destructive" size="sm" className="justify-start" onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" /> Delete Server</Button>
      </nav>

      {/* settings body */}
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="flex-1 text-lg font-semibold capitalize">{section === "audit" ? "Audit Log" : section}</h1>
          <button onClick={onClose} className="flex flex-col items-center text-muted-foreground hover:text-foreground" aria-label="Close settings">
            <span className="grid size-8 place-items-center rounded-full border border-current"><X className="size-4" /></span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto thin-scrollbar p-4">
          <TabsContent value="overview"><SettingsOverview serverName={serverName} serverDescription={serverDescription} serverIcon={serverIcon} onUploadIcon={onUploadIcon} onUpdateServer={onUpdateServer} /></TabsContent>
          <TabsContent value="members"><SettingsMembers members={members} loading={membersLoading} loadingMore={membersLoadingMore} hasMore={membersHasMore} total={membersTotal} onLoadMore={onLoadMoreMembers} onSearch={onSearchMembers} onOpenProfile={onOpenProfile} onKickMember={onKickMember} onSetRole={onSetRole} /></TabsContent>
          <TabsContent value="invites"><SettingsInvites invites={invites} loading={invitesLoading} onRevokeInvite={onRevokeInvite} onCopyInvite={onCopyInvite} /></TabsContent>
          <TabsContent value="notifications"><SettingsNotifications level={notifLevel ?? "Only @mentions"} onSetLevel={onSetNotifLevel} /></TabsContent>
          <TabsContent value="audit"><SettingsAudit auditLog={auditLog} loading={auditLogLoading} /></TabsContent>
        </div>
      </div>
    </Tabs>
    </>
  )
}

function SettingsOverview({ serverName, serverDescription, serverIcon, onUploadIcon, onUpdateServer }: { serverName: string; serverDescription?: string; serverIcon?: string | null; onUploadIcon?: () => void; onUpdateServer?: (name: string, desc: string) => void }) {
  // The draft is mount-only on purpose. The cross-server "stale draft" case
  // is already handled in layout.tsx — switching servers closes the dialog
  // (`setServerSettingsOpen(false)` in the serverId effect), which unmounts
  // <SettingsOverview>; reopening on the new server mounts a fresh instance
  // with the new initial values. Syncing props into draft state via useEffect
  // would also fire on WS-driven server renames, clobbering the user's
  // in-progress edits — keep it simple and let mount handle it.
  const [name, setName] = useState(serverName)
  const [desc, setDesc] = useState(serverDescription ?? "")
  const save = () => onUpdateServer?.(name, desc)
  return (
    <div className="max-w-xl space-y-4">
      <div className="flex items-center gap-4">
        {serverIcon ? (
          <img src={serverIcon} alt="Server icon" className="size-20 rounded-2xl object-cover" />
        ) : (
          <div className="grid size-20 place-items-center rounded-2xl bg-primary text-2xl font-semibold text-primary-foreground">{name.charAt(0)}</div>
        )}
        <div>
          <div className="text-sm font-medium">Server icon</div>
          <div className="text-xs text-muted-foreground">Recommended 512×512. PNG, JPG, or GIF.</div>
          <Button variant="secondary" size="sm" className="mt-2" onClick={onUploadIcon}>Upload image</Button>
        </div>
      </div>
      <Field label="Server name"><Input value={name} onChange={(e) => setName(e.target.value)} onBlur={save} /></Field>
      <Field label="Description"><Textarea className="h-20 resize-none" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={save} /></Field>
    </div>
  )
}

// Row height for the virtualized settings list — matches the real card height
// (border + padding + avatar + text). Slight over-estimation is fine; react-
// virtual re-measures after mount.
const SETTINGS_ROW_HEIGHT = 68

function SettingsMembers({ members, loading, loadingMore, hasMore, total, onLoadMore, onSearch, onOpenProfile, onKickMember, onSetRole }: {
  members: Member[]
  loading?: boolean
  loadingMore?: boolean
  hasMore?: boolean
  total?: number
  onLoadMore?: () => void
  onSearch?: (q: string) => void
  onOpenProfile?: OpenProfile
  onKickMember?: (name: string) => void
  onSetRole?: (name: string, role: Role) => void
}) {
  const [query, setQuery] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!onSearch) return
    const t = setTimeout(() => onSearch(query), 200)
    return () => clearTimeout(t)
  }, [query, onSearch])

  const rowVirtualizer = useVirtualizer({
    count: members.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SETTINGS_ROW_HEIGHT,
    overscan: 8,
  })

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

  if (loading && members.length === 0 && !query) return <SettingsMembersSkeleton />

  // Prefer the paginated envelope's total when present — otherwise fall back
  // to the loaded slice size. When searching, `total` still reflects the
  // server-wide count so we suffix "matches" for clarity.
  const shownCount = total ?? members.length
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onSearch && (
        <div className="relative mb-3 shrink-0">
          <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search members"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="mb-3 shrink-0 text-sm text-muted-foreground">
        {query ? `${members.length} matches` : `${shownCount} members`}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const m = members[virtualRow.index]
            return (
              <div
                key={m.id}
                role="listitem"
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingBottom: 8,
                }}
              >
                <div className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2">
                  <button onClick={(e) => onOpenProfile?.(m.name, e)} className="shrink-0">
                    <Avatar label={m.avatar} size={32} presence={m.status} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{capitalize(m.role)}</div>
                  </div>
                  {m.role === "owner" ? (
                    <Badge variant="secondary" className="gap-1"><Shield className="size-3.5" /> Owner</Badge>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<button className={badgeVariants({ variant: "secondary" }) + " cursor-pointer gap-1"} />}
                      >
                        <Shield className="size-3.5" /> {capitalize(m.role)}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-32">
                        {SETTABLE_ROLES.map((r) => (
                          <DropdownMenuItem key={r} onClick={() => onSetRole?.(m.name, r)}>{capitalize(r)}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {m.role !== "owner" && (
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Kick member" onClick={() => onKickMember?.(m.name)}><Trash2 className="size-4" /></Button>
                  )}
                </div>
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
  )
}

function SettingsInvites({ invites, loading, onRevokeInvite, onCopyInvite }: {
  invites: InviteRow[]
  loading?: boolean
  onRevokeInvite?: (code: string) => void
  onCopyInvite?: (code: string) => void
}) {
  const [revokingCode, setRevokingCode] = useState<string | null>(null)
  if (loading && invites.length === 0) return <SettingsInvitesSkeleton />
  return (
    <div className="space-y-2">
      {invites.length === 0 && (
        <p className="text-sm text-muted-foreground">No active invites — use the invite icon in the sidebar header to share this server.</p>
      )}
      {invites.map((iv) => (
        <div key={iv.code} className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
          <Link2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm">{iv.code}</div>
            <div className="text-xs text-muted-foreground" suppressHydrationWarning>by {iv.by} · {iv.uses}{iv.maxUses ? ` / ${iv.maxUses}` : ""} uses · {iv.expiresAt ? `expires ${formatRelativeTime(iv.expiresAt)}` : "never expires"}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onCopyInvite?.(iv.code)}>Copy</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Revoke invite" onClick={() => setRevokingCode(iv.code)}><X className="size-4" /></Button>
        </div>
      ))}
      <ConfirmDialog
        open={revokingCode !== null}
        onOpenChange={(o) => { if (!o) setRevokingCode(null) }}
        title="Revoke this invite?"
        description="Anyone who hasn't used it yet won't be able to join with this link. Existing members aren't affected."
        confirmLabel="Revoke invite"
        onConfirm={() => { if (revokingCode) onRevokeInvite?.(revokingCode); setRevokingCode(null) }}
      />
    </div>
  )
}

function SettingsNotifications({ level, onSetLevel }: { level: string; onSetLevel?: (l: string) => void }) {
  const levels: { value: string; label: string; hint: string }[] = [
    { value: "All messages", label: "Every message", hint: "Notify for every new message on this server" },
    { value: "Only @mentions", label: "Mentions only", hint: "Notify when someone @s you" },
    { value: "Nothing", label: "Muted", hint: "No notifications, no badges" },
  ]
  return (
    <div className="max-w-md space-y-2">
      <div className="mb-3 text-sm text-muted-foreground">Default notifications for this server</div>
      {levels.map((l) => (
        <button
          key={l.value}
          onClick={() => onSetLevel?.(l.value)}
          className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-left hover:bg-accent"
        >
          <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${level === l.value ? "border-primary" : "border-muted-foreground"}`}>
            {level === l.value && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{l.label}</div>
            <div className="text-xs text-muted-foreground">{l.hint}</div>
          </div>
        </button>
      ))}
    </div>
  )
}

function SettingsAudit({ auditLog, loading }: { auditLog: AuditEntry[]; loading?: boolean }) {
  if (loading && auditLog.length === 0) return <SettingsAuditSkeleton />
  return (
    <div className="space-y-2">
      {auditLog.length === 0 && (
        <p className="text-sm text-muted-foreground">No audit log entries yet. Admin actions will be recorded here.</p>
      )}
      {auditLog.map((e, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{e.actor}</span>{" "}
            <span className="text-muted-foreground">{e.action}</span>{" "}
            <span className="font-medium">{e.target}</span>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>{formatMessageTime(e.createdAt)}</span>
        </div>
      ))}
    </div>
  )
}

// Loading placeholders for the settings panels — match the real row heights
// so the body doesn't shift when data lands.
function SettingsMembersSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="mb-3 h-4 w-24 rounded" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/5 rounded" />
            <Skeleton className="h-3 w-16 rounded" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="size-7 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  )
}

function SettingsInvitesSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
          <Skeleton className="size-5 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2 rounded" />
            <Skeleton className="h-3 w-3/4 rounded" />
          </div>
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="size-7 shrink-0 rounded-md" />
        </div>
      ))}
    </div>
  )
}

function SettingsAuditSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className="h-4 flex-1 rounded" style={{ maxWidth: 360 + ((i * 37) % 80) }} />
          <Skeleton className="h-3 w-16 shrink-0 rounded" />
        </div>
      ))}
    </div>
  )
}
