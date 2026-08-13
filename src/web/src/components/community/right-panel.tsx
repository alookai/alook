"use client"

import { useState } from "react"
import { Users, Pin, Search, MessagesSquare } from "lucide-react"
import { Input } from "@/components/ui/input"
import { onEnterSubmit } from "@/lib/ime"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { PanelShell } from "./panel-shell"
import { MemberList } from "./member-list"
import { Message } from "./message"
import { formatRelativeTime } from "./format-time"
import { stripInlineMarkup } from "@alook/shared"
import type { RightPanel, Member, Role, Msg, RenderMsg, Thread, OpenProfile, MemberManageContext } from "./_types"

// Right-panel content router — members / pinned / search / threads. Data via props.
// Always wraps the active section in PanelShell — the surrounding Sheet provides the
// outer frame and its own close button, so we don't need a panel-level close affordance.
export function RightPanelContent({
  kind, members, membersLoading, membersLoadingMore, membersHasMore, onLoadMoreMembers, onSearchMembers,
  onAddMember, manageContext,
  pinned, pinnedLoading, searchResults, searchQuery,
  threads, threadsLoading, showSearchInput = true, onOpenThread, onOpenProfile,
  onSetRole, onKickMember, myRole, onJumpToMessage, onSearch, viewerUserId,
}: {
  kind: Exclude<RightPanel, null>
  members: Member[]
  membersLoading?: boolean
  membersLoadingMore?: boolean
  membersHasMore?: boolean
  onLoadMoreMembers?: () => void
  onSearchMembers?: (q: string) => void
  onAddMember?: () => void
  manageContext?: MemberManageContext
  pinned: Msg[]
  pinnedLoading?: boolean
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  threadsLoading?: boolean
  showSearchInput?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (memberId: string, role: Role) => void
  onKickMember?: (memberId: string) => Promise<unknown> | void
  myRole?: Role
  // Jump to a pinned message by its per-channel seq — routes through the same
  // message-ref jump flow (scroll-in-place if loaded, else open the context
  // sheet), so a click always gives feedback even for an out-of-window pin.
  onJumpToMessage?: (seq: number) => void
  onSearch?: (query: string) => void
  viewerUserId?: string
}) {
  if (kind === "members")
    return (
      <PanelShell icon={Users} title="Members" bodyClassName="p-0">
        <MemberList
          members={members}
          loading={membersLoading}
          hasMore={membersHasMore}
          loadingMore={membersLoadingMore}
          onLoadMore={onLoadMoreMembers}
          onSearch={onSearchMembers}
          onAddMember={onAddMember}
          manageContext={manageContext}
          myRole={myRole}
          onOpenProfile={onOpenProfile}
          onSetRole={onSetRole}
          onKick={onKickMember}
        />
      </PanelShell>
    )
  if (kind === "pinned")
    return (
      <PanelShell icon={Pin} title="Pinned Messages">
        {pinnedLoading && pinned.length === 0 ? (
          <PinnedListSkeleton />
        ) : pinned.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">No pinned messages yet.</div>
        ) : (
          pinned.map((m) => (
            <button
              key={m.id}
              onClick={() => m.seq != null && onJumpToMessage?.(m.seq)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
            >
              <span className="shrink-0">
                <Avatar label={m.authorAvatar ?? "?"} seed={m.authorId} size={24} />
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{m.authorName}</span>
                  {m.createdAt && <span className="text-xs text-muted-foreground">{formatRelativeTime(m.createdAt)}</span>}
                </div>
                <div className="truncate text-sm text-muted-foreground">{stripInlineMarkup(m.content ?? "")}</div>
              </div>
            </button>
          ))
        )}
      </PanelShell>
    )
  if (kind === "search")
    return (
      <SearchPanel
        searchResults={searchResults}
        initialQuery={searchQuery}
        showSearchInput={showSearchInput}
        onOpenProfile={onOpenProfile}
        onSearch={onSearch}
        viewerUserId={viewerUserId}
      />
    )
  return (
    <PanelShell icon={MessagesSquare} title="Threads">
      {threadsLoading && threads.length === 0 ? (
        <ThreadListSkeleton />
      ) : (
        <>
      <div className="mb-2 text-xs text-muted-foreground">{threads.length} threads</div>
      <div className="space-y-1">
        {threads.map((t) => (
          <button
            key={t.id}
            onClick={() => onOpenThread(t.id)}
            className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
          >
            <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{t.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{t.parent.authorName}</span> {stripInlineMarkup(t.parent.text)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground" suppressHydrationWarning>{t.messageCount} messages · {formatRelativeTime(t.lastMessageAt)}</div>
            </div>
          </button>
        ))}
      </div>
        </>
      )}
    </PanelShell>
  )
}

// Loading placeholders for the right-panel sub-views — sized to match the
// real row heights so the panel body doesn't reflow when data lands.
function PinnedListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex gap-2 rounded-md px-2 py-2">
          <Skeleton className="size-6 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-3 w-10 rounded" />
            </div>
            <Skeleton className="h-3 w-5/6 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ThreadListSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 rounded-md px-2 py-2">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/5 rounded" />
            <Skeleton className="h-3 w-11/12 rounded" />
            <Skeleton className="h-3 w-2/5 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function SearchPanel({
  searchResults,
  initialQuery,
  showSearchInput,
  onOpenProfile,
  onSearch,
  viewerUserId,
}: {
  searchResults: Msg[]
  initialQuery?: string
  showSearchInput?: boolean
  onOpenProfile?: OpenProfile
  onSearch?: (query: string) => void
  viewerUserId?: string
}) {
  const [query, setQuery] = useState(initialQuery ?? "")
  const submit = () => { const q = query.trim(); if (q) onSearch?.(q) }
  return (
    <PanelShell icon={Search} title="Search">
      {showSearchInput && (
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search messages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onEnterSubmit(submit)}
          />
        </div>
      )}
      <div className="mb-2 text-xs text-muted-foreground">{searchResults.length} results</div>
      {searchResults.map((m) => {
        const renderMsg: RenderMsg = { ...m, grouped: false }
        return (
          <Message
            key={m.id}
            m={renderMsg}
            compact
            viewerUserId={viewerUserId}
            onOpenThread={() => {}}
            onOpenProfile={onOpenProfile}
          />
        )
      })}
    </PanelShell>
  )
}
