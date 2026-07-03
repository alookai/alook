"use client"

import { useEffect, useState } from "react"
import type { LucideIcon } from "lucide-react"
import { Bell, BellOff, Pin, Users, MessagesSquare, ListChevronsUpDown, ChevronLeft, Check, Pencil, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { ChannelIcon } from "./channel-icon"
import type { RightPanel } from "./_types"

// Skeleton header for the loading frame between route change and channel
// metadata arriving. Same h-12 footprint as <ChannelHeader> so the body below
// doesn't shift when the real header lands.
export function ChannelHeaderSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      <Skeleton className="ml-1 size-4 rounded" />
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

export type ChannelNotifLevel = "Use Server Default" | "All Messages" | "Only @mentions" | "Nothing"

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
  breadcrumb?: { label: string; onRename?: (name: string) => void; onNavigateBack?: () => void }
  server?: { name: string; icon: string | null }
  tools?: { threads?: boolean; pinned?: boolean; members?: boolean }
}) {

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
      {server && <ServerCrumb name={server.name} icon={server.icon} />}
      {breadcrumb ? (
        <>
          <button onClick={breadcrumb.onNavigateBack} className={`flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors ${server ? "" : "ml-1"}`}>
            {forum ? <ListChevronsUpDown className="size-4 shrink-0" /> : <ChannelIcon className="text-base" />}
            <span className="truncate text-base font-medium">{channel}</span>
          </button>
          <ChannelIcon className="shrink-0 text-base text-muted-foreground/60" />
          <span className="min-w-0 truncate text-base font-medium">{breadcrumb.label}</span>
          {breadcrumb.onRename && (
            <BreadcrumbRename label={breadcrumb.label} onRename={breadcrumb.onRename} />
          )}
        </>
      ) : (
        <>
          {forum ? <ListChevronsUpDown className={`size-4 shrink-0 text-muted-foreground ${server ? "" : "ml-1"}`} /> : <ChannelIcon className={`text-base text-muted-foreground ${server ? "" : "ml-1"}`} />}
          <span className="truncate text-base font-semibold">{channel}</span>
        </>
      )}
      <div className="ml-auto flex items-center text-muted-foreground">
        {tools?.members !== false && tool("members", Users, "Member list")}
        <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />
        <ChannelNotifDropdown level={notifLevel ?? "Use Server Default"} onSetLevel={onSetNotifLevel} />
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

// Leading breadcrumb segment for mobile — the server avatar. The channel segment
// that follows leads with its own "/" (or forum icon), which serves as the separator.
// Purely contextual (the rail is hidden at mobile widths).
function ServerCrumb({ name, icon }: { name: string; icon: string | null }) {
  return (
    <span className="ml-1 grid size-5 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary text-[0.625rem] font-semibold text-foreground" aria-label={name} title={name}>
      {icon ? <img src={icon} alt="" className="size-full object-cover" /> : name.charAt(0).toUpperCase()}
    </span>
  )
}

const NOTIF_LEVELS: { value: ChannelNotifLevel; label: string; hint: string }[] = [
  { value: "Use Server Default", label: "Use server default", hint: "Inherit this server's setting" },
  { value: "All Messages", label: "Every message", hint: "Notify for every new message" },
  { value: "Only @mentions", label: "Mentions only", hint: "Notify when someone @s you" },
  { value: "Nothing", label: "Muted", hint: "No notifications, no badges" },
]

function ChannelNotifDropdown({ level, onSetLevel }: {
  level: ChannelNotifLevel
  onSetLevel?: (l: ChannelNotifLevel) => void
}) {
  const isMuted = level === "Nothing"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-sm" className={`text-muted-foreground hover:text-foreground ${isMuted ? "text-destructive" : ""}`} aria-label="Channel notifications" />}
      >
        {isMuted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={() => onSetLevel?.(isMuted ? "Use Server Default" : "Nothing")}>
          {isMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          {isMuted ? "Unmute channel" : "Mute channel"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {NOTIF_LEVELS.map((n) => (
          <DropdownMenuItem key={n.value} onClick={() => onSetLevel?.(n.value)}>
            <span className="min-w-0 flex-1 text-sm">{n.label}</span>
            {level === n.value && <Check className="size-4 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BreadcrumbRename({ label, onRename }: { label: string; onRename: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(label)
  // Keep the draft mirror in sync with the upstream label whenever the dialog
  // is closed — covers WS-driven renames and channel switches (the parent
  // component is reused across channelId changes).
  useEffect(() => {
    if (!open) setDraft(label)
  }, [label, open])
  const save = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== label) onRename(trimmed)
    setOpen(false)
  }
  return (
    <>
      <Button variant="ghost" size="icon-sm" onClick={() => { setDraft(label); setOpen(true) }} className="text-muted-foreground hover:text-foreground" aria-label="Rename">
        <Pencil className="size-3.5" />
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => { if (!o) setOpen(false) }}>
          <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
            <DialogHeader className="border-b border-border px-4 py-4">
              <DialogTitle>Rename Thread</DialogTitle>
            </DialogHeader>
            <div className="px-4 pb-5 pt-4">
              <label className="block">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</div>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") save() }}
                  placeholder="thread-name"
                  className="h-10"
                  autoFocus
                />
              </label>
            </div>
            <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={!draft.trim()}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
