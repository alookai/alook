"use client"

import { useState, useMemo } from "react"
import { Users, Pin, Search, MessagesSquare } from "lucide-react"
import { Input } from "@/components/ui/input"
import { PanelShell } from "./panel-shell"
import { MemberList } from "./member-list"
import { Message } from "./message"
import { formatRelativeTime } from "./format-time"
import type { RightPanel, Member, Role, Msg, Thread, OpenProfile } from "./_types"

// Right-panel content router — members / pinned / search / threads. Data via props.
export function RightPanelContent({
  kind, members, pinned, searchResults, searchQuery, threads, onClose, showClose, onOpenThread, onOpenProfile,
  onSetRole, onKickMember, myRole,
}: {
  kind: Exclude<RightPanel, null>
  members: Member[]
  pinned: Msg[]
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  onClose: () => void
  showClose?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (name: string, role: Role) => void
  onKickMember?: (name: string) => void
  myRole?: Role
}) {
  if (kind === "members")
    // Desktop shows the bare list under the spanning channel header (no own header).
    // The mobile full-screen panel wraps it so it gets a dismiss bar.
    return showClose ? (
      <PanelShell icon={Users} title="Members" onClose={onClose} showClose bodyClassName="p-0">
        <MemberList members={members} myRole={myRole} onOpenProfile={onOpenProfile} onSetRole={onSetRole} onKick={onKickMember} />
      </PanelShell>
    ) : (
      <MemberList members={members} myRole={myRole} onOpenProfile={onOpenProfile} onSetRole={onSetRole} onKick={onKickMember} />
    )
  if (kind === "pinned")
    return (
      <PanelShell icon={Pin} title="Pinned Messages" onClose={onClose} showClose={showClose}>
        {pinned.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} compact onOpenThread={() => {}} onOpenProfile={onOpenProfile} />)}
      </PanelShell>
    )
  if (kind === "search")
    return <SearchPanel searchResults={searchResults} initialQuery={searchQuery} onClose={onClose} showClose={showClose} onOpenProfile={onOpenProfile} />
  // threads — channel thread list. Picking one opens it in the message area.
  return (
    <PanelShell icon={MessagesSquare} title="Threads" onClose={onClose} showClose={showClose}>
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

function SearchPanel({ searchResults, initialQuery, onClose, showClose, onOpenProfile }: {
  searchResults: Msg[]; initialQuery?: string; onClose: () => void; showClose?: boolean; onOpenProfile?: OpenProfile
}) {
  const [query, setQuery] = useState(initialQuery ?? "")
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return q ? searchResults.filter((m) => m.content?.toLowerCase().includes(q) || m.authorName?.toLowerCase().includes(q)) : searchResults
  }, [query, searchResults])
  return (
    <PanelShell icon={Search} title="Search" onClose={onClose} showClose={showClose}>
      <div className="relative mb-3">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="h-9 pl-8" placeholder="Search messages" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="mb-2 text-xs text-muted-foreground">{filtered.length} results</div>
      {filtered.map((m) => <Message key={m.id} m={{ ...m, grouped: false }} compact onOpenThread={() => {}} onOpenProfile={onOpenProfile} />)}
    </PanelShell>
  )
}
