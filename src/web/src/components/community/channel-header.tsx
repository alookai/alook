"use client"

import { useEffect, useState } from "react"
import type { LucideIcon } from "lucide-react"
import { Bell, BellOff, Pin, Users, MessagesSquare, ChevronLeft, Check, Pencil, MoreHorizontal } from "lucide-react"
import { NOTIF_LEVELS, USE_SERVER_DEFAULT, type NotifLevel } from "@alook/shared"
import { Button } from "@/components/ui/button"
import { avatarInitial } from "@/lib/community/avatar"
import { Input } from "@/components/ui/input"
import { onEnterSubmit } from "@/lib/ime"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { ChannelIcon } from "./channel-icon"
import { EntityIcon } from "./entity-icon"
import { SlugHint } from "./slug-hint"
import { previewSlug } from "@/lib/community/slug-preview"
import { MarbleBackground } from "@/components/avatar"
import type { RightPanel } from "./_types"
import { CreateDialogShell } from "./create-dialog-shell"

// Skeleton header for the loading frame between route change and channel
// metadata arriving. Same h-12 footprint as <ChannelHeader> so the body below
// doesn't shift when the real header lands.
export function ChannelHeaderSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Skeleton className="ml-1 size-6 rounded-md" />
      <Skeleton className="h-4 w-32 rounded" />
      <div className="ml-auto flex items-center text-muted-foreground">
        <Skeleton className="size-7 rounded-md" />
        <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="size-7 rounded-md" />
      </div>
    </header>
  )
}

// A channel can inherit the server default (UI-only sentinel) or pin one of the
// three real levels. Derived from the shared single-source so the strings can't
// drift from the notif-level bijection.
export type ChannelNotifLevel = typeof USE_SERVER_DEFAULT | NotifLevel

export function ChannelHeader({
  channel, rightPanel, onToggle, notifLevel, onSetNotifLevel, onBack,
  breadcrumb, forum, server, tools,
}: {
  channel: string
  rightPanel: RightPanel
  onToggle: (k: Exclude<RightPanel, null>) => void
  notifLevel?: ChannelNotifLevel
  onSetNotifLevel?: (l: ChannelNotifLevel) => void
  onBack?: () => void
  forum?: boolean
  breadcrumb?: { label: string; onRename?: (name: string) => void | Promise<void>; titleRename?: boolean; onNavigateBack?: () => void }
  server?: { id: string; name: string; icon: string | null }
  tools?: { threads?: boolean; pinned?: boolean; members?: boolean }
}) {

  // The parent-channel entity glyph (breadcrumb crumb + non-breadcrumb badge)
  // is `<EntityIcon kind={...}>`. The `<ChannelIcon>` breadcrumb SEPARATOR
  // below is a different glyph — leave it.
  const entityKind = forum ? "forum" : "text"
  const tool = (k: Exclude<RightPanel, null>, Icon: LucideIcon, label: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => onToggle(k)}
      aria-label={label}
      className={`text-muted-foreground hover:text-foreground ${rightPanel === k ? "bg-accent text-foreground" : ""}`}
    >
      <Icon className="size-4" />
    </Button>
  )
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      {server && <ServerCrumb id={server.id} name={server.name} icon={server.icon} size={6} className="ml-1" />}
      {breadcrumb ? (
        <>
          <button onClick={breadcrumb.onNavigateBack} className={`flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors ${server ? "" : "ml-1"}`}>
            <EntityIcon kind={entityKind} className="size-4 shrink-0" />
            <span className="truncate text-base font-medium">{channel}</span>
          </button>
          <ChannelIcon className="shrink-0 text-base text-muted-foreground/60" />
          <span className="min-w-0 truncate text-base font-medium" title={breadcrumb.label}>{breadcrumb.label}</span>
          {breadcrumb.onRename && (
            <BreadcrumbRename label={breadcrumb.label} onRename={breadcrumb.onRename} titleMode={breadcrumb.titleRename} />
          )}
        </>
      ) : (
        <>
          <div className={`grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground ${server ? "" : "ml-1"}`}>
            <EntityIcon kind={entityKind} className="size-4" />
          </div>
          <span className="truncate text-base font-semibold">{channel}</span>
        </>
      )}
      <div className="ml-auto flex items-center text-muted-foreground">
        {tools?.members !== false && tool("members", Users, "Member list")}
        <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />
        <ChannelNotifDropdown level={notifLevel ?? USE_SERVER_DEFAULT} onSetLevel={onSetNotifLevel} />
        {(tools?.threads !== false || tools?.pinned !== false) && (
          <ChannelOverflowMenu
            rightPanel={rightPanel}
            onToggle={onToggle}
            showThreads={tools?.threads !== false}
            showPinned={tools?.pinned !== false}
          />
        )}
      </div>
    </header>
  )
}

function ChannelOverflowMenu({
  rightPanel, onToggle, showThreads, showPinned,
}: {
  rightPanel: RightPanel
  onToggle: (k: Exclude<RightPanel, null>) => void
  showThreads: boolean
  showPinned: boolean
}) {
  const activeInside = (rightPanel === "threads" && showThreads) || (rightPanel === "pinned" && showPinned)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More channel options"
            className={`text-muted-foreground hover:text-foreground ${activeInside ? "bg-accent text-foreground" : ""}`}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {showThreads && (
          <DropdownMenuItem onClick={() => onToggle("threads")}>
            <MessagesSquare className="size-4" />
            <span className="flex-1">Threads</span>
            {rightPanel === "threads" && <Check className="size-4 shrink-0 text-primary" />}
          </DropdownMenuItem>
        )}
        {showPinned && (
          <DropdownMenuItem onClick={() => onToggle("pinned")}>
            <Pin className="size-4" />
            <span className="flex-1">Pinned messages</span>
            {rightPanel === "pinned" && <Check className="size-4 shrink-0 text-primary" />}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Server identity chip — icon (or initial-letter fallback) in a rounded
// square. The mobile breadcrumb's leading segment (the channel segment that
// follows leads with its own "/" or forum icon, which serves as the
// separator). Tailwind only picks up complete literal class names at build
// time, so `size` can't be interpolated — it's an explicit ternary.
function ServerCrumb({ id, name, icon, size = 5, className = "" }: { id: string; name: string; icon: string | null; size?: 5 | 6 | 7; className?: string }) {
  const sizeCls = size === 7 ? "size-7" : size === 6 ? "size-6" : "size-5"
  const iconTextCls = size === 7 ? "text-xs" : size === 6 ? "text-[0.6875rem]" : "text-[0.625rem]"
  const initialTextCls = size === 7 ? "text-base" : size === 6 ? "text-sm" : "text-xs"
  return (
    <span
      // No icon → the same deterministic marble fallback used by the rail
      // (`sortable-server.tsx`) and folder rows, so a server reads as "the
      // same server" everywhere it shows up, not a flat generic tile here.
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-md ${icon ? `font-semibold ${iconTextCls} bg-secondary text-foreground` : `font-brand font-bold ${initialTextCls} text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)]`} ${sizeCls} ${className}`}
      aria-label={name}
      title={name}
    >
      {icon ? <img src={icon} alt="" className="size-full object-cover" /> : <><MarbleBackground seed={id} /><span className="relative -translate-x-[1px] [-webkit-text-stroke:0.5px_currentColor]">{avatarInitial(name)}</span></>}
    </span>
  )
}

// The channel dropdown = the inherit sentinel first, then the three shared
// levels (menu label + hint straight from the single source).
const CHANNEL_NOTIF_OPTIONS: { value: ChannelNotifLevel; label: string; hint: string }[] = [
  { value: USE_SERVER_DEFAULT, label: "Use server default", hint: "Inherit this server's setting" },
  ...NOTIF_LEVELS.map((l) => ({ value: l.display, label: l.label, hint: l.hint })),
]

// The "Nothing" display string (the muted state's level) pulled from the single
// source so the mute-toggle comparison can't drift.
const MUTED_LEVEL: NotifLevel = NOTIF_LEVELS.find((l) => l.value === "nothing")!.display

function ChannelNotifDropdown({ level, onSetLevel }: {
  level: ChannelNotifLevel
  onSetLevel?: (l: ChannelNotifLevel) => void
}) {
  const isMuted = level === MUTED_LEVEL
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" className={`text-muted-foreground hover:text-foreground ${isMuted ? "text-destructive" : ""}`} aria-label="Channel notifications" />}
      >
        {isMuted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={() => onSetLevel?.(isMuted ? USE_SERVER_DEFAULT : MUTED_LEVEL)}>
          {isMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          {isMuted ? "Unmute channel" : "Mute channel"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {CHANNEL_NOTIF_OPTIONS.map((n) => (
          <DropdownMenuItem key={n.value} onClick={() => onSetLevel?.(n.value)}>
            <span className="min-w-0 flex-1 text-sm">{n.label}</span>
            {level === n.value && <Check className="size-4 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BreadcrumbRename({ label, onRename, titleMode = false }: { label: string; onRename: (name: string) => void | Promise<void>; titleMode?: boolean }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(label)
  const [saving, setSaving] = useState(false)
  // Keep the draft mirror in sync with the upstream label whenever the dialog
  // is closed — covers WS-driven renames and channel switches (the parent
  // component is reused across channelId changes).
  useEffect(() => {
    if (!open) setDraft(label)
  }, [label, open])
  const draftPreview = previewSlug(draft)
  const validDraft = titleMode ? Boolean(draft.trim()) : Boolean(draftPreview.slug)
  const save = async () => {
    const trimmed = draft.trim()
    if (!validDraft || trimmed === label) {
      setOpen(false)
      return
    }
    setSaving(true)
    try {
      await onRename(trimmed)
      setOpen(false)
    } catch {
      // The owner surfaces the API error. Keep the dialog and draft open so
      // the user can correct or retry the same title.
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <Button variant="ghost" size="icon-sm" onClick={() => { setDraft(label); setOpen(true) }} className="text-muted-foreground hover:text-foreground" aria-label={titleMode ? "Edit post title" : "Rename"}>
        <Pencil className="size-3.5" />
      </Button>
      {open && (
        titleMode ? (
          <CreateDialogShell
            onClose={() => setOpen(false)}
            title="Edit post title"
            footer={(
              <>
                <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                <Button size="sm" onClick={() => void save()} disabled={!validDraft || saving}>Save</Button>
              </>
            )}
          >
            <div className="px-5 pb-5 pt-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onEnterSubmit(save)}
                placeholder="Post title"
                aria-label="Post title"
                className="w-full border-0 bg-transparent p-0 text-[30px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
                autoFocus
              />
            </div>
          </CreateDialogShell>
        ) : (
        <Dialog open onOpenChange={(o) => { if (!o) setOpen(false) }}>
          <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
            <DialogHeader className="border-b border-border px-4 py-4">
              <DialogTitle>Rename Thread</DialogTitle>
            </DialogHeader>
            <div className="px-4 pb-5 pt-4">
              <label className="block">
                <div className="mb-2 text-xs font-semibold text-muted-foreground">Name</div>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onEnterSubmit(save)}
                  placeholder="thread-name"
                  aria-label="Thread name"
                  className="h-10"
                  autoFocus
                />
                <SlugHint {...draftPreview} />
              </label>
            </div>
            <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={() => void save()} disabled={!validDraft || saving}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        )
      )}
    </>
  )
}
