"use client"

import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Settings, Users, Link2, Bell, Trash2, X, Shield, Search, Camera } from "lucide-react"
import {
  isServerOwner,
  NOTIF_LEVELS,
  notifLevelDisplay,
  type CommunityRole as Role,
} from "@alook/shared"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/lib/community/format-time"
import { Input } from "@/components/ui/input"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { Badge, badgeVariants } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import { ServerIcon } from "../server-icon"
import { avatarInitial } from "@/lib/community/avatar"
import { SlugHint } from "./slug-hint"
import { previewSlug } from "@/lib/community/slug-preview"
import { tid } from "@/lib/community/testids"
import { useInvites } from "@/hooks/community/use-server-panels"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import type { Member, InviteRow } from "@/lib/community/models/people"
import type { OpenProfile } from "@/components/community/social/profile-types"
import { SettingsShell, SettingsShellPanel, type SettingsShellTab } from "./settings-shell"
import { useBots } from "@/hooks/community/use-bots"
import {
  resolveServerNotificationDisplayLevel,
  useBotNotificationSetting,
  useSetBotNotificationSetting,
} from "@/hooks/community/use-notification-settings"
import { toastApiError } from "@/lib/api/client"

const SETTABLE_ROLES: Role[] = ["admin", "member"]

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Full-screen server settings view. Data via props.
export function ServerSettings({
  section, setSection, onClose, serverId, serverName, serverDescription, serverIcon,
  members, membersLoading, membersLoadingMore, membersHasMore, membersTotal, onLoadMoreMembers, onSearchMembers,
  onOpenProfile,
  onKickMember, onSetRole, onRevokeInvite, onCopyInvite, onDeleteServer, onUploadIcon, onUpdateServer, notifLevel, onSetNotifLevel,
}: {
  section: SettingsSection
  setSection: (s: SettingsSection) => void
  onClose: () => void
  serverId: string
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
  onOpenProfile?: OpenProfile
  onKickMember?: (memberId: string) => void
  onSetRole?: (memberId: string, role: Role) => void
  onRevokeInvite?: (code: string) => void
  onCopyInvite?: (code: string) => void
  onDeleteServer?: () => void
  onUploadIcon?: () => void
  onUpdateServer?: (name: string, desc: string) => void
  notifLevel?: string
  onSetNotifLevel?: (l: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Invites are low-frequency, admin-only panel data. Fetch them only when
  // their tab is open, never on settings mount or via WS.
  const { invites, isLoading: invitesLoading } = useInvites(serverId, section === "invites")

  const nav: SettingsShellTab<SettingsSection>[] = [
    { value: "overview", label: "Overview", icon: Settings },
    { value: "members", label: "Members", icon: Users },
    { value: "invites", label: "Invites", icon: Link2 },
    { value: "notifications", label: "Notifications", icon: Bell },
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
      <SettingsShell
        value={section}
        onValueChange={setSection}
        label={serverName}
        title={<span className="capitalize">{section}</span>}
        tabs={nav}
        onClose={onClose}
      >
        <SettingsShellPanel value="overview"><SettingsOverview serverId={serverId} serverName={serverName} serverDescription={serverDescription} serverIcon={serverIcon} onUploadIcon={onUploadIcon} onUpdateServer={onUpdateServer} onRequestDelete={() => setConfirmDelete(true)} /></SettingsShellPanel>
        <SettingsShellPanel value="members"><SettingsMembers members={members} loading={membersLoading} loadingMore={membersLoadingMore} hasMore={membersHasMore} total={membersTotal} onLoadMore={onLoadMoreMembers} onSearch={onSearchMembers} onOpenProfile={onOpenProfile} onKickMember={onKickMember} onSetRole={onSetRole} /></SettingsShellPanel>
        <SettingsShellPanel value="invites"><SettingsInvites invites={invites} loading={invitesLoading} onRevokeInvite={onRevokeInvite} onCopyInvite={onCopyInvite} /></SettingsShellPanel>
        <SettingsShellPanel value="notifications"><SettingsNotifications serverId={serverId} level={notifLevel} onSetLevel={onSetNotifLevel} /></SettingsShellPanel>
      </SettingsShell>
    </>
  )
}

function SettingsOverview({ serverId, serverName, serverDescription, serverIcon, onUploadIcon, onUpdateServer, onRequestDelete }: { serverId: string; serverName: string; serverDescription?: string; serverIcon?: string | null; onUploadIcon?: () => void; onUpdateServer?: (name: string, desc: string) => void; onRequestDelete?: () => void }) {
  // The draft is mount-only on purpose. The cross-server "stale draft" case
  // is already handled in layout.tsx — switching servers closes the dialog
  // (`setServerSettingsOpen(false)` in the serverId effect), which unmounts
  // <SettingsOverview>; reopening on the new server mounts a fresh instance
  // with the new initial values. Syncing props into draft state via useEffect
  // would also fire on WS-driven server renames, clobbering the user's
  // in-progress edits — keep it simple and let mount handle it.
  const [name, setName] = useState(serverName)
  const [desc, setDesc] = useState(serverDescription ?? "")
  // Saved baseline is mount-only (same rationale as the draft above): a WS
  // rename must not reset it mid-edit. Advances only on a successful save.
  const [baseline, setBaseline] = useState({ name: serverName, desc: serverDescription ?? "" })
  const namePreview = previewSlug(name)
  const dirty = name !== baseline.name || desc !== baseline.desc
  const save = () => {
    if (namePreview.invalid || !dirty) return
    onUpdateServer?.(name, desc)
    setBaseline({ name, desc })
  }
  const cancel = () => {
    setName(baseline.name)
    setDesc(baseline.desc)
  }
  return (
    <div className="mx-auto w-full max-w-md space-y-8">
      <section className="space-y-8">
        {/* Server icon — centered in a soft rounded frame + hand-rolled pill
            (matches My Profile; a stock secondary Button reads as the old box). */}
        <div className="flex flex-col items-center gap-2">
          <span className="block overflow-hidden rounded-2xl ring-1 ring-border/50">
            <ServerIcon id={serverId} name={name} initial={avatarInitial(name)} icon={serverIcon} size={96} className="rounded-2xl" />
          </span>
          <button
            type="button"
            onClick={onUploadIcon}
            className="flex min-h-11 items-center gap-2 rounded-full border border-border/50 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-8"
          >
            <Camera className="size-3.5" /> Change icon
          </button>
        </div>
        {/* Server name — borderless inline title. */}
        <div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Server name"
            aria-label="Server name"
            data-testid={tid.serverSettingsName}
            className="min-h-11 w-full rounded-sm border-0 bg-transparent px-0 py-1 text-xl font-medium leading-[1.2] tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background sm:text-2xl"
          />
          <SlugHint {...namePreview} />
        </div>
        {/* Description — borderless auto-resizing textarea. */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Description</div>
          <AutoResizeTextarea
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="What's this server about?"
            className="min-h-11 w-full rounded-sm border-0 bg-transparent px-0 py-1 text-sm leading-6 text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          />
        </div>
        <div className="flex items-center justify-start gap-2">
          <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={cancel} disabled={!dirty}>Cancel</Button>
          <Button size="sm" className="h-11 sm:h-8" onClick={save} disabled={!dirty || namePreview.invalid}>Save changes</Button>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-medium tracking-tight text-destructive">Danger Zone</h2>
        {/* Unframed — the red heading + destructive button carry the signal;
            the extra border/box just added weight. */}
        <p className="text-sm leading-6 text-muted-foreground">
          Deleting this server is permanent and cannot be undone. All channels, messages, and members will be permanently removed.
        </p>
        <Button variant="destructive" size="sm" className="h-11 sm:h-8" onClick={onRequestDelete}><Trash2 className="size-4" /> Delete Server</Button>
      </section>
    </div>
  )
}

// Row height estimate for the virtualized settings list — a frameless hover
// row (px-2 py-2 + 32px avatar + 8px paddingBottom) is shorter than the old
// bordered card. Slight over/under-estimation is fine; react-virtual
// re-measures each row after mount via `measureElement`.
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
  onKickMember?: (memberId: string) => void
  onSetRole?: (memberId: string, role: Role) => void
}) {
  const [query, setQuery] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!onSearch) return
    const t = setTimeout(() => onSearch(query), 200)
    return () => clearTimeout(t)
  }, [query, onSearch])

  // TanStack Virtual returns unstable function refs — React Compiler skips memoization.
  // eslint-disable-next-line react-hooks/incompatible-library -- library limitation
  const rowVirtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: members.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => members[index]?.id ?? index,
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

  if (loading && members.length === 0 && !query) {
    return <SettingsMembersSkeleton showSearch={Boolean(onSearch)} />
  }

  // Prefer the paginated envelope's total when present — otherwise fall back
  // to the loaded slice size. When searching, `total` still reflects the
  // server-wide count so we suffix "matches" for clarity.
  const shownCount = total ?? members.length
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-xl flex-col">
      {onSearch && (
        <div className="relative mb-4 shrink-0">
          <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-11 pl-8 sm:h-9"
            placeholder="Search members"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      <div className="mb-4 shrink-0 text-sm text-muted-foreground">
        {query ? `${members.length} matches` : `${shownCount} members`}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
        <div ref={rowVirtualizer.containerRef} style={{ position: "relative", width: "100%" }}>
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
                  paddingBottom: 8,
                }}
              >
                <div className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40">
                  <button onClick={(e) => onOpenProfile?.(m.name, e, undefined, m.userId)} className="grid size-11 shrink-0 place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:size-8">
                    <Avatar label={m.avatar} seed={m.userId} size={32} presence={m.status} ringColor="var(--background)" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium">{m.name}</div>
                    <div className="text-xs text-muted-foreground">{capitalize(m.role)}</div>
                  </div>
                  {isServerOwner(m.role) ? (
                    <Badge variant="secondary" className="gap-1"><Shield className="size-3.5" /> Owner</Badge>
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<button className={badgeVariants({ variant: "secondary" }) + " min-h-11 cursor-pointer gap-1 sm:min-h-6"} />}
                      >
                        <Shield className="size-3.5" /> {capitalize(m.role)}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-32">
                        {SETTABLE_ROLES.map((r) => (
                          <DropdownMenuItem key={r} onClick={() => onSetRole?.(m.id, r)}>{capitalize(r)}</DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  {m.role !== "owner" && (
                    <Button variant="ghost" size="icon-sm" className="size-11 text-muted-foreground hover:text-destructive sm:size-7" aria-label="Kick member" onClick={() => onKickMember?.(m.id)}><Trash2 className="size-4" /></Button>
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
    <div className="mx-auto max-w-xl space-y-2">
      {invites.length === 0 && (
        <p className="text-sm text-muted-foreground">No active invites — use the invite icon in the sidebar header to share this server.</p>
      )}
      {invites.map((iv) => (
        <div key={iv.code} className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent/40">
          <Link2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div data-testid={tid.inviteToken} className="truncate font-mono text-sm">{iv.code}</div>
            <div className="text-xs text-muted-foreground" suppressHydrationWarning>by {iv.by} · {iv.uses}{iv.maxUses ? ` / ${iv.maxUses}` : ""} uses · {iv.expiresAt ? `expires ${formatRelativeTime(iv.expiresAt)}` : "never expires"}</div>
          </div>
          <Button variant="secondary" size="sm" className="h-11 sm:h-8" data-testid={tid.inviteCopy} onClick={() => onCopyInvite?.(iv.code)}>Copy</Button>
          <Button variant="ghost" size="icon-sm" className="size-11 text-muted-foreground hover:text-destructive sm:size-8" aria-label="Revoke invite" onClick={() => setRevokingCode(iv.code)}><X className="size-4" /></Button>
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

export function SettingsNotifications({ serverId, level, onSetLevel }: { serverId: string; level?: string; onSetLevel?: (l: string) => void }) {
  const { bots } = useBots()
  const [botId, setBotId] = useState<string | null>(null)
  const botSetting = useBotNotificationSetting(botId, { kind: "server", id: serverId })
  const setBotSetting = useSetBotNotificationSetting()
  const selectedLevel = botId
    ? notifLevelDisplay((botSetting.data?.level ?? "all") as "all" | "mentions" | "nothing")
    : resolveServerNotificationDisplayLevel(level)
  // Server-level dropdown = the three shared levels (no "Use Server Default"
  // sentinel — that's channel-only). Value/label/hint from the single source.
  const levels = NOTIF_LEVELS.map((l) => ({
    value: l.display,
    raw: l.value,
    label: l.label,
    hint: l.value === "all" ? "Notify for every new message on this server" : l.hint,
  }))
  const update = (display: string, raw: "all" | "mentions" | "nothing") => {
    if (!botId) return onSetLevel?.(display)
    setBotSetting.mutate({ botId, scope: { kind: "server", id: serverId }, level: raw }, {
      onError: (error) => toastApiError(error, "Failed to update bot notifications"),
    })
  }
  return (
    <div className="mx-auto max-w-md space-y-2">
      <div className="mb-3 text-sm text-muted-foreground">Default notifications for this server</div>
      {bots.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1" aria-label="Notification actor">
          <Button size="sm" className="h-11 sm:h-8" variant={botId === null ? "secondary" : "ghost"} onClick={() => setBotId(null)}>You</Button>
          {bots.map((bot) => (
            <Button key={bot.id} size="sm" className="h-11 sm:h-8" variant={botId === bot.id ? "secondary" : "ghost"} onClick={() => setBotId(bot.id)}>{bot.name}</Button>
          ))}
        </div>
      )}
      {botId && botSetting.isError && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">This bot cannot access this server.</div>
      )}
      {levels.map((l) => (
        <button
          key={l.value}
          onClick={() => update(l.value, l.raw)}
          disabled={Boolean(botId && (botSetting.isLoading || botSetting.isError || setBotSetting.isPending))}
          className={`flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors disabled:opacity-50 ${selectedLevel === l.value ? "bg-accent" : "hover:bg-accent/40"}`}
        >
          <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${selectedLevel === l.value ? "border-primary" : "border-muted-foreground"}`}>
            {selectedLevel === l.value && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{l.label}</div>
            <div className="text-xs text-muted-foreground">{l.hint}</div>
          </div>
        </button>
      ))}
      <p className="pt-2 text-xs text-muted-foreground">Changing this setting clears existing unread in every affected channel.</p>
    </div>
  )
}

// Loading placeholders for the settings panels — match the real row heights
// so the body doesn't shift when data lands.
function SettingsMembersSkeleton({ showSearch }: { showSearch: boolean }) {
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-xl flex-col">
      {showSearch && <Skeleton className="mb-4 h-11 shrink-0 rounded-md sm:h-9" />}
      <Skeleton className="mb-4 h-4 w-24 shrink-0 rounded" />
      <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
              <Skeleton className="size-11 shrink-0 rounded-full sm:size-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-2/5 rounded" />
                <Skeleton className="h-3 w-16 rounded" />
              </div>
              <Skeleton className="h-11 w-16 rounded-full sm:h-6" />
              <Skeleton className="size-11 shrink-0 rounded-md sm:size-7" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SettingsInvitesSkeleton() {
  return (
    <div className="mx-auto max-w-xl space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2">
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
