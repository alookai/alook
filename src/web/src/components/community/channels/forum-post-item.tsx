"use client"

import { memo, type ReactNode } from "react"
import { MessagesSquare } from "@/components/icons/lucide"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { avatarInitial } from "@/lib/community/avatar"
import { formatRelativeTime } from "@/lib/community/format-time"
import type { ForumThread } from "@/lib/community/models/message"
import type { CommunityProfile } from "@/lib/community/models/people"
import { readCommunityProfile } from "@/lib/community/profile-read"
import { tid } from "@/lib/community/testids"
import { cn } from "@/lib/utils"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import { Avatar } from "../avatar"

const MAX_AVATARS = 5
const MAX_VISIBLE_TAGS = 2

export function shouldActivateForumRow(event: {
  key: string
  target: EventTarget | null
  currentTarget: EventTarget | null
}) {
  return event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")
}

function ForumTagSummary({ tags }: { tags: string[] }) {
  const ordinaryTags = tags.filter((tag) => tag !== FORUM_ARCHIVE_TAG)
  const shown = ordinaryTags.slice(0, MAX_VISIBLE_TAGS)
  const hidden = ordinaryTags.slice(MAX_VISIBLE_TAGS)
  if (shown.length === 0) return null

  return (
    <div
      className="flex min-w-0 items-center gap-2 max-sm:order-last max-sm:basis-full max-sm:pl-7"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {shown.map((tag) => <span key={tag} className="max-w-24 truncate">#{tag}</span>)}
      {hidden.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={(
              <Button variant="ghost" size="sm"
                type="button"
                className="h-auto shrink-0 px-1 py-0.5 text-xs"
                aria-label={`Show ${hidden.length} more tags`}
                onClick={(event) => event.stopPropagation()}
              >
                +{hidden.length}
              </Button>
            )}
          />
          <PopoverContent
            side="top"
            align="start"
            className="flex w-52 flex-wrap gap-2 p-2"
            onClick={(event) => event.stopPropagation()}
          >
            {ordinaryTags.map((tag) => (
              <span key={tag} className="rounded-md bg-muted px-1.5 py-1 text-xs text-muted-foreground">#{tag}</span>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

const ForumPostTitle = memo(function ForumPostTitle({ name, postId, seq }: { name: string; postId: string; seq?: number }) {
  return (
    <h3
      data-testid={tid.forumThreadTitle(postId)}
      aria-label={`${name}${seq === undefined ? "" : ` #${seq}`}`}
      title={name}
      className="w-full min-w-0 max-w-full self-center text-[15px] font-semibold leading-tight"
    >
      <span className="flex min-w-0 max-w-full items-baseline">
        <span data-testid={tid.forumThreadTitleText(postId)} className="min-w-0 truncate">{name}</span>
        {seq === undefined ? null : (
          <span
            data-testid={tid.forumThreadSeq(postId)}
            className="ml-1.5 shrink-0 whitespace-nowrap font-mono text-[13px] font-medium text-muted-foreground"
          >
            <span className="opacity-60">#</span>{seq}
          </span>
        )}
      </span>
    </h3>
  )
})

export function ForumPostItem({ post: p, profilesByUserId, onOpen, actions }: {
  post: ForumThread
  profilesByUserId: ReadonlyMap<string, CommunityProfile>
  onOpen: () => void
  actions?: ReactNode
}) {
  const hasOrdinaryTags = p.tags.some((tag) => tag !== FORUM_ARCHIVE_TAG)
  const author = readCommunityProfile(
    profilesByUserId.get(p.authorId),
    p.authorId,
  )
  const others = p.participants.filter((m) => m.id !== p.authorId)
  const shown = others.slice(0, MAX_AVATARS)
  const participantTotal = p.participantCount ?? others.length + 1
  const overflow = Math.max(0, participantTotal - 1 - shown.length)
  return (
    <div
      role="button"
      tabIndex={0}
      data-page-swipe-navigation-row=""
      data-msg-id={p.openerMessageId || undefined}
      data-testid={tid.forumThreadCard(p.id)}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!shouldActivateForumRow(event)) return
        event.preventDefault()
        onOpen()
      }}
      className="relative cursor-pointer rounded px-4 py-0 text-left"
    >
      <div className={cn("grid grid-rows-[minmax(2rem,max-content)_auto] gap-x-2", actions ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1")}>
        <ForumPostTitle name={p.name} postId={p.id} seq={p.parentSeq} />
        {actions}

        <p data-slot="community-forum-post-preview" className="col-span-full row-start-2 mb-2 line-clamp-2 text-[13.5px] text-muted-foreground">{p.preview}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Avatar label={author.avatar} seed={p.authorId} size={20} />
        <span data-slot="community-forum-post-author" title={author.name} className="min-w-0 max-w-[min(12rem,40%)] shrink-0 truncate font-medium text-foreground" suppressHydrationWarning>{author.name}</span>
        <span className="shrink-0" aria-hidden>·</span>
        <span className="shrink-0" suppressHydrationWarning>Active {formatRelativeTime(p.lastMessageAt)}</span>
        {hasOrdinaryTags && <span className="shrink-0 max-sm:hidden" aria-hidden>·</span>}
        <ForumTagSummary tags={p.tags} />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {others.length > 0 && (
            <AvatarGroup className="-space-x-1.25" data-testid={tid.forumThreadAvatars(p.id)}>
              {shown.map((member) => {
                const canonical = profilesByUserId.get(member.id)
                const avatar = canonical
                  ? readCommunityProfile(canonical, member.id).avatar
                  : (member.avatar || avatarInitial(member.name))
                return (
                  <Avatar key={member.id} label={avatar} seed={member.id} size={19} ringColor="var(--background)" />
                )
              })}
              {overflow > 0 && <AvatarGroupCount className="size-4.75 text-[10px]">+{overflow}</AvatarGroupCount>}
            </AvatarGroup>
          )}
          <span className="flex items-center gap-1">
            <MessagesSquare className="size-3.5" /> {Math.max(0, p.messageCount)}
          </span>
        </span>
      </div>
    </div>
  )
}
