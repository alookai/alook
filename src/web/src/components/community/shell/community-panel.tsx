"use client"

import { useState } from "react"
import { MessagesSquare, Pin, Search, Users } from "lucide-react"
import { stripInlineMarkup, type CommunityRole as Role } from "@alook/shared"

import { Avatar } from "@/components/community/avatar"
import { MemberList } from "@/components/community/members/member-list"
import { Message } from "@/components/community/messages/message"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { formatRelativeTime } from "@/lib/community/format-time"
import { onEnterSubmit } from "@/lib/ime"
import type { MemberManageContext } from "@/components/community/members/member-management-types"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { Msg, RenderMsg, Thread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"

export type CommunityPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: Exclude<RightPanel, null>
  members: Member[]
  membersLoading?: boolean
  membersLoadingMore?: boolean
  membersHasMore?: boolean
  onLoadMoreMembers?: () => void
  onSearchMembers?: (query: string) => void
  onAddMember?: () => void
  manageContext?: MemberManageContext
  pinned: Msg[]
  pinnedLoading?: boolean
  searchResults: Msg[]
  searchQuery?: string
  threads: Thread[]
  threadsLoading?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (memberId: string, role: Role) => void
  onKickMember?: (memberId: string) => Promise<unknown> | void
  myRole?: Role
  onJumpToMessage?: (seq: number) => void
  onSearch?: (query: string) => void
  viewerUserId?: string
}

/** Members, pins, search, and threads business content in the shared modal shell. */
export function CommunityPanel(props: CommunityPanelProps) {
  const { open, onOpenChange, kind } = props
  const { icon: Icon, label } = panelHeading(kind)

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </span>
      )}
      bodyClassName={kind === "members" ? "p-0 sm:p-0" : undefined}
    >
      {renderCommunityPanelBody(props)}
    </CommunitySheet>
  )
}

function renderCommunityPanelBody({
  kind,
  members,
  membersLoading,
  membersLoadingMore,
  membersHasMore,
  onLoadMoreMembers,
  onSearchMembers,
  onAddMember,
  manageContext,
  pinned,
  pinnedLoading,
  searchResults,
  searchQuery,
  threads,
  threadsLoading,
  onOpenThread,
  onOpenProfile,
  onSetRole,
  onKickMember,
  myRole,
  onJumpToMessage,
  onSearch,
  viewerUserId,
}: CommunityPanelProps) {
  if (kind === "members") {
    return (
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
    )
  }

  if (kind === "pinned") {
    if (pinnedLoading && pinned.length === 0) return <PinnedListSkeleton />
    if (pinned.length === 0) {
      return <div className="py-8 text-center text-sm text-muted-foreground">No pinned messages yet.</div>
    }
    return pinned.map((message) => (
      <button
        key={message.id}
        onClick={() => message.seq != null && onJumpToMessage?.(message.seq)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
      >
        <span className="shrink-0">
          <Avatar label={message.authorAvatar ?? "?"} seed={message.authorId} size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{message.authorName}</span>
            {message.createdAt && (
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(message.createdAt)}
              </span>
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {stripInlineMarkup(message.content ?? "")}
          </div>
        </div>
      </button>
    ))
  }

  if (kind === "search") {
    return (
      <SearchPanel
        searchResults={searchResults}
        initialQuery={searchQuery}
        onOpenProfile={onOpenProfile}
        onSearch={onSearch}
        viewerUserId={viewerUserId}
      />
    )
  }

  if (threadsLoading && threads.length === 0) return <ThreadListSkeleton />
  return (
    <>
      <div className="mb-2 text-xs text-muted-foreground">{threads.length} threads</div>
      <div className="space-y-1">
        {threads.map((thread) => (
          <button
            key={thread.id}
            onClick={() => onOpenThread(thread.id)}
            className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
          >
            <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{thread.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{thread.parent.authorName}</span>{" "}
                {stripInlineMarkup(thread.parent.text)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground" suppressHydrationWarning>
                {thread.messageCount} messages · {formatRelativeTime(thread.lastMessageAt)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  )
}

function panelHeading(kind: Exclude<RightPanel, null>) {
  switch (kind) {
    case "members":
      return { icon: Users, label: "Members" }
    case "pinned":
      return { icon: Pin, label: "Pinned Messages" }
    case "search":
      return { icon: Search, label: "Search" }
    case "threads":
      return { icon: MessagesSquare, label: "Threads" }
  }
}

function SearchPanel({
  searchResults,
  initialQuery,
  onOpenProfile,
  onSearch,
  viewerUserId,
}: {
  searchResults: Msg[]
  initialQuery?: string
  onOpenProfile?: OpenProfile
  onSearch?: (query: string) => void
  viewerUserId?: string
}) {
  const [query, setQuery] = useState(initialQuery ?? "")
  const submit = () => {
    const nextQuery = query.trim()
    if (nextQuery) onSearch?.(nextQuery)
  }

  return (
    <>
      <div className="relative mb-3">
        <Search className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-9 pl-8"
          placeholder="Search messages"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onEnterSubmit(submit)}
        />
      </div>
      <div className="mb-2 text-xs text-muted-foreground">{searchResults.length} results</div>
      {searchResults.map((message) => {
        const renderMessage: RenderMsg = { ...message, grouped: false }
        return (
          <Message
            key={message.id}
            m={renderMessage}
            compact
            viewerUserId={viewerUserId}
            onOpenThread={() => {}}
            onOpenProfile={onOpenProfile}
          />
        )
      })}
    </>
  )
}

function PinnedListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex gap-2 rounded-md px-2 py-2">
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
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-start gap-3 rounded-md px-2 py-2">
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
