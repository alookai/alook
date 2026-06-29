"use client"

import { useState, useRef, useEffect } from "react"
import type { LucideIcon } from "lucide-react"
import { Bell, BellOff, Pin, Users, Search, MessagesSquare, ChevronLeft, X, Check, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { ChannelIcon } from "./channel-icon"
import type { RightPanel } from "./_types"

export type ChannelNotifLevel = "Use Server Default" | "All Messages" | "Only @mentions" | "Nothing"

// Channel header — title + thread/notif/pin/member/search toolbar.
// Search has two modes:
//  - searchBox (desktop): clicking the search button expands an inline input;
//    typing + Enter submits the query → opens the search panel.
//  - !searchBox (mobile): the icon opens the panel directly (search happens inside it).
export function ChannelHeader({
  channel, rightPanel, onToggle, onSearch, notifLevel, onSetNotifLevel, onBack, searchBox,
  breadcrumb, forum, server, tools,
}: {
  channel: string
  rightPanel: RightPanel
  onToggle: (k: Exclude<RightPanel, null>) => void
  onSearch?: (query: string) => void
  notifLevel?: ChannelNotifLevel
  onSetNotifLevel?: (l: ChannelNotifLevel) => void
  onBack?: () => void
  searchBox?: boolean
  forum?: boolean
  breadcrumb?: { label: string; onRename?: (name: string) => void; onNavigateBack?: () => void }
  server?: { name: string; icon: string | null }
  // Per-tool visibility (default: all shown). Forums hide threads/pinned.
  tools?: { threads?: boolean; pinned?: boolean; members?: boolean }
}) {
  const [searchActive, setSearchActive] = useState(false)
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (searchActive) inputRef.current?.focus()
  }, [searchActive])

  const submitSearch = () => {
    const q = query.trim()
    if (!q) return
    onSearch?.(q)
    setSearchActive(false)
    setQuery("")
  }

  const tool = (k: Exclude<RightPanel, null>, Icon: LucideIcon, label: string) => (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => onToggle(k)}
      aria-label={label}
      className={`text-muted-foreground hover:text-foreground ${rightPanel === k ? "bg-accent text-foreground" : ""}`}
    >
      <Icon className="size-4.5" />
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
            {forum ? <MessagesSquare className="size-4 shrink-0" /> : <ChannelIcon className="text-base" />}
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
          {forum ? <MessagesSquare className={`size-4 shrink-0 text-muted-foreground ${server ? "" : "ml-1"}`} /> : <ChannelIcon className={`text-base text-muted-foreground ${server ? "" : "ml-1"}`} />}
          <span className="truncate text-base font-medium">{channel}</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-1 text-muted-foreground">
        {tools?.threads !== false && tool("threads", MessagesSquare, "Threads")}
        <ChannelNotifDropdown level={notifLevel ?? "Use Server Default"} onSetLevel={onSetNotifLevel} />
        {tools?.pinned !== false && tool("pinned", Pin, "Pinned messages")}
        {tools?.members !== false && tool("members", Users, "Member list")}
        {/* Mobile: icon opens the panel directly */}
        {!searchBox && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onToggle("search")}
            aria-label="Search"
            className={`text-muted-foreground hover:text-foreground ${rightPanel === "search" ? "bg-accent text-foreground" : ""}`}
          >
            <Search className="size-4.5" />
          </Button>
        )}
      </div>
      {/* Desktop: inline search input that expands on click */}
      {searchBox && !searchActive && (
        <Button
          variant="secondary"
          onClick={() => setSearchActive(true)}
          className="ml-2 h-8 w-60 shrink-0 justify-between font-normal text-muted-foreground hover:text-foreground"
        >
          Search <Search className="size-4" />
        </Button>
      )}
      {searchBox && searchActive && (
        <div className="relative ml-2 flex h-8 w-60 shrink-0 items-center">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitSearch(); if (e.key === "Escape") { setSearchActive(false); setQuery("") } }}
            placeholder="Search messages…"
            className="h-full pr-8"
          />
          {query ? (
            <button onClick={submitSearch} className="absolute right-2 text-muted-foreground hover:text-foreground" aria-label="Submit search">
              <Search className="size-4" />
            </button>
          ) : (
            <button onClick={() => { setSearchActive(false); setQuery("") }} className="absolute right-2 text-muted-foreground hover:text-foreground" aria-label="Close search">
              <X className="size-4" />
            </button>
          )}
        </div>
      )}
    </header>
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

const NOTIF_LEVELS: ChannelNotifLevel[] = [
  "Use Server Default",
  "All Messages",
  "Only @mentions",
  "Nothing",
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
        {isMuted ? <BellOff className="size-4.5" /> : <Bell className="size-4.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => onSetLevel?.(isMuted ? "Use Server Default" : "Nothing")}>
          {isMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
          {isMuted ? "Unmute Channel" : "Mute Channel"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {NOTIF_LEVELS.map((n) => (
          <DropdownMenuItem key={n} onClick={() => onSetLevel?.(n)}>
            <span className="min-w-0 flex-1 text-sm">{n}</span>
            {level === n && <Check className="size-4 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BreadcrumbRename({ label, onRename }: { label: string; onRename: (name: string) => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(label)
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
            <DialogHeader className="border-b border-border px-5 py-4">
              <DialogTitle>Rename Thread</DialogTitle>
            </DialogHeader>
            <div className="px-5 pb-5 pt-4">
              <label className="block">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Name</div>
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
            <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={!draft.trim()}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
