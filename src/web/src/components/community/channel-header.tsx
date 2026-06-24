"use client"

import { useState, useRef, useEffect } from "react"
import type { LucideIcon } from "lucide-react"
import { Hash, Bell, BellOff, Pin, Users, Search, MessagesSquare, Menu, ChevronLeft, X, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import type { RightPanel } from "./_types"

export type ChannelNotifLevel = "Use Server Default" | "All Messages" | "Only @mentions" | "Nothing"

// Channel header — title + thread/notif/pin/member/search toolbar.
// Search has two modes:
//  - searchBox (desktop/tablet): clicking the search button expands an inline input;
//    typing + Enter submits the query → opens the search panel.
//  - !searchBox (mobile): the icon opens the panel directly (search happens inside it).
export function ChannelHeader({
  channel, rightPanel, onToggle, onSearch, notifLevel, onSetNotifLevel, onHamburger, onBack, searchBox,
}: {
  channel: string
  rightPanel: RightPanel
  onToggle: (k: Exclude<RightPanel, null>) => void
  onSearch?: (query: string) => void
  notifLevel?: ChannelNotifLevel
  onSetNotifLevel?: (l: ChannelNotifLevel) => void
  onHamburger?: () => void
  onBack?: () => void
  searchBox?: boolean
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
      <Icon className="size-5" />
    </Button>
  )
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      {onHamburger && (
        <Button variant="ghost" size="icon-sm" onClick={onHamburger} className="text-muted-foreground hover:text-foreground" aria-label="Open channels"><Menu className="size-5" /></Button>
      )}
      <Hash className="ml-1 size-6 text-muted-foreground" />
      <h1 className="truncate text-base font-medium">{channel}</h1>
      <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
        {tool("threads", MessagesSquare, "Threads")}
        <ChannelNotifDropdown level={notifLevel ?? "Use Server Default"} onSetLevel={onSetNotifLevel} />
        {tool("pinned", Pin, "Pinned messages")}
        {tool("members", Users, "Member list")}
        {/* Mobile: icon opens the panel directly */}
        {!searchBox && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onToggle("search")}
            aria-label="Search"
            className={`text-muted-foreground hover:text-foreground ${rightPanel === "search" ? "bg-accent text-foreground" : ""}`}
          >
            <Search className="size-5" />
          </Button>
        )}
      </div>
      {/* Desktop/tablet: inline search input that expands on click */}
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
        {isMuted ? <BellOff className="size-5" /> : <Bell className="size-5" />}
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
