"use client"

import { useState } from "react"
import { Users, Pin, Search, MessagesSquare } from "lucide-react"
import { Input } from "@/components/ui/input"
import { PanelShell } from "./panel-shell"
import { MemberList } from "./member-list"
import { Message } from "./message"
import { formatRelativeTime } from "./format-time"
import type { RightPanel, Member, Role, Msg, Thread, OpenProfile } from "./_types"

// Right-panel content router — members / pinned / search / threads. Data via props.
// Always wraps the active section in PanelShell — the surrounding Sheet provides the
// outer frame and its own close button, so we don't need a panel-level close affordance.
export function RightPanelContent({
  kind, members, pinned, searchResults, searchQuery, threads, showSearchInput = true, onOpenThread, onOpenProfile,
  onSetRole, onKickMember, myRole, onJumpToMessage, onSearch,
}: {
  kind: Exclude<RightPanel, null>
  members: Member[]
  pinned: Msg[]
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  showSearchInput?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKickMember?: (name: string) => void
  myRole?: Role
  onJumpToMessage?: (id: string) => void
  onSearch?: (query: string) => void
}) {
  if (kind === "members")
    return (
      <PanelShell icon={Users} title="Members" bodyClassName="p-0">
        <MemberList members={members} myRole={myRole} onOpenProfile={onOpenProfile} onSetRole={onSetRole} onKick={onKickMember} />
      </PanelShell>
    )
  if (kind === "pinned")
    return (
      <PanelShell icon={Pin} title="Pinned Messages">
        {pinned.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No pinned messages yet.</div>
        ) : (
          pinned.map((m) => (
            <button
              key={m.id}
              onClick={() => onJumpToMessage?.(m.id)}
              className="flex w-full gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
            >
              <div className="size-6 shrink-0 rounded-full bg-muted grid place-items-center text-xs font-medium">
                {m.authorAvatar ?? m.authorName?.charAt(0) ?? "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm font-medium">{m.authorName}</span>
                  {m.createdAt && <span className="text-xs text-muted-foreground">{formatRelativeTime(m.createdAt)}</span>}
                </div>
                <div className="truncate text-sm text-muted-foreground">{m.content}</div>
              </div>
            </button>
          ))
        )}
      </PanelShell>
    )
  if (kind === "search")
    return <SearchPanel searchResults={searchResults} initialQuery={searchQuery} showSearchInput={showSearchInput} onOpenProfile={onOpenProfile} onSearch={onSearch} />
  return (
    <PanelShell icon={MessagesSquare} title="Threads">
      <div className="mb-2 text-xs text-muted-foreground">{threads.length} threads</div>
      <div className="space-y-2">
        {threads.map((t) => (
          <button
            key={t.id}
            onClick={() => onOpenThread(t.id)}
            className="flex w-full items-start gap-3 rounded-md border border-border bg-card p-3 text-left hover:bg-accent"
          >
            <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{t.parent.authorName}</span> {t.parent.text}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground" suppressHydrationWarning>{t.messageCount} messages · {formatRelativeTime(t.lastMessageAt)}</div>
            </div>
          </button>
        ))}
      </div>
    </PanelShell>
  )
}

function SearchPanel({ searchResults, initialQuery, showSearchInput, onOpenProfile, onSearch }: {
  searchResults: Msg[]; initialQuery?: string; showSearchInput?: boolean; onOpenProfile?: OpenProfile; onSearch?: (query: string) => void
}) {
  const [query, setQuery] = useState(initialQuery ?? "")
  const submit = () => { const q = query.trim(); if (q) onSearch?.(q) }
  return (
    <PanelShell icon={Search} title="Search">
      {showSearchInput && (
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search messages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit() }}
          />
        </div>
      )}
      <div className="mb-2 text-xs text-muted-foreground">{searchResults.length} results</div>
      {searchResults.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} compact onOpenThread={() => {}} onOpenProfile={onOpenProfile} />)}
    </PanelShell>
  )
}
