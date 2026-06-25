"use client"

import { useState } from "react"
import type { LucideIcon } from "lucide-react"
import { Settings, Users, Link2, Bell, ScrollText, Trash2, X, Shield } from "lucide-react"
import { ConfirmDialog } from "./confirm-dialog"
import { Button } from "@/components/ui/button"
import { formatMessageTime, formatRelativeTime } from "./format-time"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Avatar } from "./avatar"
import { Field } from "./field"
import type { SettingsSection, Member, Role, InviteRow, AuditEntry, OpenProfile } from "./_types"

const SETTABLE_ROLES: Role[] = ["Admin", "Member"]

// Full-screen server settings view. Data via props.
export function ServerSettings({
  section, setSection, onClose, serverName, serverDescription, serverIcon, members, invites, auditLog, onOpenProfile,
  onKickMember, onSetRole, onRevokeInvite, onCreateInvite, onCopyInvite, onDeleteServer, onUploadIcon, onUpdateServer, notifLevel, onSetNotifLevel,
}: {
  section: SettingsSection
  setSection: (s: SettingsSection) => void
  onClose: () => void
  serverName: string
  serverDescription?: string
  serverIcon?: string | null
  members: Member[]
  invites: InviteRow[]
  auditLog: AuditEntry[]
  onOpenProfile?: OpenProfile
  onKickMember?: (name: string) => void
  onSetRole?: (name: string, role: Role) => void
  onRevokeInvite?: (code: string) => void
  onCreateInvite?: () => void
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
      title={`Delete "${serverName}"?`}
      description="This cannot be undone. All channels, messages, and members will be permanently removed."
      confirmLabel="Delete Server"
      destructive
      onConfirm={() => { setConfirmDelete(false); onDeleteServer?.() }}
      onCancel={() => setConfirmDelete(false)}
    />
    <Tabs
      orientation="vertical"
      value={section}
      onValueChange={(v) => setSection(v as SettingsSection)}
      className="min-h-0 flex-1 flex-row gap-0"
    >
      {/* settings nav */}
      <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar border-r border-border p-3" style={{ background: "var(--d-rail)" }}>
        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{serverName}</div>
        <TabsList variant="line" className="h-auto w-full flex-col gap-0.5">
          {nav.map((n) => (
            <TabsTrigger key={n.id} value={n.id} className="h-8 w-full justify-start gap-2">
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
        <div className="flex-1 overflow-y-auto thin-scrollbar p-5">
          <TabsContent value="overview"><SettingsOverview serverName={serverName} serverDescription={serverDescription} serverIcon={serverIcon} onUploadIcon={onUploadIcon} onUpdateServer={onUpdateServer} /></TabsContent>
          <TabsContent value="members"><SettingsMembers members={members} onOpenProfile={onOpenProfile} onKickMember={onKickMember} onSetRole={onSetRole} /></TabsContent>
          <TabsContent value="invites"><SettingsInvites invites={invites} onRevokeInvite={onRevokeInvite} onCreateInvite={onCreateInvite} onCopyInvite={onCopyInvite} /></TabsContent>
          <TabsContent value="notifications"><SettingsNotifications level={notifLevel ?? "Only @mentions"} onSetLevel={onSetNotifLevel} /></TabsContent>
          <TabsContent value="audit"><SettingsAudit auditLog={auditLog} /></TabsContent>
        </div>
      </div>
    </Tabs>
    </>
  )
}

function SettingsOverview({ serverName, serverDescription, serverIcon, onUploadIcon, onUpdateServer }: { serverName: string; serverDescription?: string; serverIcon?: string | null; onUploadIcon?: () => void; onUpdateServer?: (name: string, desc: string) => void }) {
  const [name, setName] = useState(serverName)
  const [desc, setDesc] = useState(serverDescription ?? "")
  const save = () => onUpdateServer?.(name, desc)
  return (
    <div className="max-w-xl space-y-5">
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

function SettingsMembers({ members, onOpenProfile, onKickMember, onSetRole }: {
  members: Member[]
  onOpenProfile?: OpenProfile
  onKickMember?: (name: string) => void
  onSetRole?: (name: string, role: Role) => void
}) {
  return (
    <div className="space-y-1">
      <div className="mb-2 text-sm text-muted-foreground">{members.length} members</div>
      {members.map((m) => (
        <div key={m.name} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
          <button onClick={(e) => onOpenProfile?.(m.name, e)} className="shrink-0">
            <Avatar label={m.avatar} size={32} presence={m.status} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-medium">{m.name}</div>
            <div className="text-xs text-muted-foreground">{m.role}</div>
          </div>
          {m.role === "Owner" ? (
            // Owner is fixed (server creator) — shown, not editable
            <Badge variant="secondary" className="gap-1"><Shield className="size-3.5" /> Owner</Badge>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Badge variant="secondary" className="cursor-pointer gap-1" />}
              >
                <Shield className="size-3.5" /> {m.role}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                {SETTABLE_ROLES.map((r) => (
                  <DropdownMenuItem key={r} onClick={() => onSetRole?.(m.name, r)}>{r}</DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {m.role !== "Owner" && (
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Kick member" onClick={() => onKickMember?.(m.name)}><Trash2 className="size-4" /></Button>
          )}
        </div>
      ))}
    </div>
  )
}

function SettingsInvites({ invites, onRevokeInvite, onCreateInvite, onCopyInvite }: {
  invites: InviteRow[]
  onRevokeInvite?: (code: string) => void
  onCreateInvite?: () => void
  onCopyInvite?: (code: string) => void
}) {
  return (
    <div className="space-y-2">
      {invites.length === 0 && (
        <p className="text-sm text-muted-foreground">No active invites. Create one to let people join this server.</p>
      )}
      {invites.map((iv) => (
        <div key={iv.code} className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5">
          <Link2 className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm">/community/invite/{iv.code}</div>
            <div className="text-xs text-muted-foreground" suppressHydrationWarning>by {iv.by} · {iv.uses}{iv.maxUses ? ` / ${iv.maxUses}` : ""} uses · {iv.expiresAt ? `expires ${formatRelativeTime(iv.expiresAt)}` : "never expires"}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => onCopyInvite?.(iv.code)}>Copy</Button>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label="Revoke invite" onClick={() => onRevokeInvite?.(iv.code)}><X className="size-4" /></Button>
        </div>
      ))}
      <Button size="sm" className="mt-2" onClick={onCreateInvite}>Create invite</Button>
    </div>
  )
}

function SettingsNotifications({ level, onSetLevel }: { level: string; onSetLevel?: (l: string) => void }) {
  const levels = ["All messages", "Only @mentions", "Nothing"]
  return (
    <div className="max-w-md space-y-2">
      <div className="mb-2 text-sm text-muted-foreground">Server notification setting</div>
      {levels.map((l) => (
        <button
          key={l}
          onClick={() => onSetLevel?.(l)}
          className="flex w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 text-left hover:bg-accent"
        >
          <span className={`grid size-4 place-items-center rounded-full border ${level === l ? "border-primary" : "border-muted-foreground"}`}>
            {level === l && <span className="size-2 rounded-full bg-primary" />}
          </span>
          <span className="text-sm font-medium">{l}</span>
        </button>
      ))}
    </div>
  )
}

function SettingsAudit({ auditLog }: { auditLog: AuditEntry[] }) {
  return (
    <div className="space-y-1">
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
