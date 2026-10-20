"use client"

import { useLayoutEffect, useState } from "react"
import { MessagesSquare, Pin, Users } from "lucide-react"
import { stripInlineMarkup, type CommunityRole as Role } from "@alook/shared"

import { Avatar } from "@/components/community/avatar"
import { MemberList } from "@/components/community/members/member-list"
import { MessageAuthorLine } from "@/components/community/messages/message-author-line"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { formatRelativeTime } from "@/lib/community/format-time"
import type { MemberManageContext } from "@/components/community/members/member-management-types"
import type { OpenProfile } from "@/components/community/social/profile-types"
import type { RightPanel } from "@/components/community/shell/panel-types"
import type { Msg, Thread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import type { CommunityProfile } from "@/lib/community/models/people"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"

export type CommunityPanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: RightPanel
  members: Member[]
  memberScopeId?: string
  membersLoading?: boolean
  membersLoadingMore?: boolean
  membersHasMore?: boolean
  onLoadMoreMembers?: () => void
  onSearchMembers?: (query: string) => void
  onAddMember?: () => void
  manageContext?: MemberManageContext
  pinned: Msg[]
  pinnedLoading?: boolean
  threads: Thread[]
  threadsLoading?: boolean
  onOpenThread: (id: string) => void
  onOpenProfile?: OpenProfile
  onSetRole?: (memberId: string, role: Role) => void
  onKickMember?: (memberId: string) => Promise<unknown> | void
  myRole?: Role
  onJumpToMessage?: (seq: number) => void
}

export function CommunityPanel(props: CommunityPanelProps) {
  const { open, onOpenChange, kind } = props
  const [retained, setRetained] = useState(kind)
  useLayoutEffect(() => { if (kind) setRetained(kind) }, [kind])
  const displayed = kind ?? retained
  const profilesByUserId = useCanonicalProfilesByUserId()
  if (!displayed) return null
  const { icon: Icon, label } = panelHeading(displayed)

  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(open) => { if (!open) setRetained(null) }}
      title={(
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </span>
      )}
      desktopWidth={kind === "members" ? 380 : undefined}
      bodyClassName={kind === "members" ? "p-0 sm:p-0" : undefined}
    >
      {renderCommunityPanelBody({ ...props, kind: displayed }, profilesByUserId)}
    </CommunitySheet>
  )
}

function renderCommunityPanelBody({
  kind,
  members,
  memberScopeId,
  membersLoading,
  membersLoadingMore,
  membersHasMore,
  onLoadMoreMembers,
  onSearchMembers,
  onAddMember,
  manageContext,
  pinned,
  pinnedLoading,
  threads,
  threadsLoading,
  onOpenThread,
  onOpenProfile,
  onSetRole,
  onKickMember,
  myRole,
  onJumpToMessage,
}: CommunityPanelProps, profilesByUserId: ReadonlyMap<string, CommunityProfile>) {
  if (kind === "members") {
    return (
      <MemberList
        scopeId={memberScopeId}
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
    return pinned.map((message) => {
      const author = readCommunityProfile(
        message.authorId ? profilesByUserId.get(message.authorId) : undefined,
        message.authorId ?? "",
      )
      return (
      <button
        key={message.id}
        onClick={() => message.seq != null && onJumpToMessage?.(message.seq)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
      >
        <span className="shrink-0">
          <Avatar label={author.avatar} seed={message.authorId} size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <MessageAuthorLine
            variant="compact"
            authorName={author.name}
            timestamp={message.createdAt ? formatRelativeTime(message.createdAt) : undefined}
            timestampProps={{ dateTime: message.createdAt }}
          />
          <div className="truncate text-sm text-muted-foreground">
            {stripInlineMarkup(message.content ?? "")}
          </div>
        </div>
      </button>
      )
    })
  }

  if (threadsLoading && threads.length === 0) return <ThreadListSkeleton />
  return (
    <>
      <div className="mb-2 text-xs text-muted-foreground">{threads.length} threads</div>
      <div className="space-y-1">
        {threads.map((thread) => {
          const author = thread.parent.authorId
            ? readCommunityProfile(
                profilesByUserId.get(thread.parent.authorId),
                thread.parent.authorId,
              )
            : null
          return (
          <button
            key={thread.id}
            onClick={() => onOpenThread(thread.id)}
            className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent"
          >
            <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{thread.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  {author?.name ?? thread.parent.authorName}
                </span>{" "}
                {stripInlineMarkup(thread.parent.text)}
              </div>
              <div className="mt-1 text-xs text-muted-foreground" suppressHydrationWarning>
                {thread.messageCount} messages · {formatRelativeTime(thread.lastMessageAt)}
              </div>
            </div>
          </button>
          )
        })}
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
    case "threads":
      return { icon: MessagesSquare, label: "Threads" }
  }
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
