"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { memo, useRef } from "react"
import { Archive, ArchiveRestore, MessagesSquare, Plus, Tag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LineClamp } from "@/components/ui/line-clamp"
import { formatRelativeTime } from "@/lib/community/format-time"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CreateForumThread, type NewForumThread } from "../messages/create-forum-thread"
import type { ComposerProps } from "../messages/composer"
import { PostTagDialog } from "./post-tag-dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { tid } from "@/lib/community/testids"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { tagColorClassName, tagColorStyle } from "@/lib/community/tag-color"
import { cn } from "@/lib/utils"
import { FORUM_ARCHIVE_TAG, getClientPlatform } from "@alook/shared"
import { FORUM_LIST_SPACING_CLASS, ForumPostList, ForumPostListItem } from "./forum-post-list"
import { useHydratedClient } from "@/hooks/use-hydrated-client"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  HorizontalOverflowFadeOverlays,
  horizontalOverflowFades,
  useHorizontalOverflowRail,
} from "@/components/horizontal-overflow-rail"

const MAX_AVATARS = 5
const MAX_VISIBLE_TAGS = 2
const POST_ACTION_CLASS = "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
const POST_ROW_CLASS = "px-4 py-0"

export function shouldActivateForumRow(event: {
  key: string
  target: EventTarget | null
  currentTarget: EventTarget | null
}) {
  return event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")
}

export const forumTagScrollFades = horizontalOverflowFades

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

export function toggleForumArchivedStatus(tags: string[]): string[] {
  const ordinaryTags = tags.filter((tag) => tag !== FORUM_ARCHIVE_TAG)
  return tags.includes(FORUM_ARCHIVE_TAG)
    ? ordinaryTags
    : [...ordinaryTags, FORUM_ARCHIVE_TAG]
}

const ForumPostTitle = memo(function ForumPostTitle({ name, postId, seq }: { name: string; postId: string; seq?: number }) {
  return (
    <h3
      data-testid={tid.forumThreadTitle(postId)}
      aria-label={`${name}${seq === undefined ? "" : ` #${seq}`}`}
      title={name}
      className="w-full min-w-0 max-w-full self-center text-[15px] font-semibold leading-tight"
    >
      <LineClamp
        text={name}
        maxLines={1}
        textTestId={tid.forumThreadTitleText(postId)}
        after={seq === undefined ? undefined : (
          <span
            data-testid={tid.forumThreadSeq(postId)}
            className="font-mono text-[13px] font-medium text-muted-foreground"
          >
            <span className="opacity-60">#</span>{seq}
          </span>
        )}
      />
    </h3>
  )
})

export function ForumView({
  forumChannelId,
  members,
  mentionCandidates,
  posts, loading, observation, tag, availableTags = [], onTagChange, onOpenPost, onCreatePost, onEditPostTags, canEditPostTags, savingTagsFor,
  tagsKnown = true, tagsError = false, onRetryTags,
  hasMore, loadingMore, isFetching, isError, onLoadMore,
  onDeletePost, canDeletePost, deletingPost,
  onScrollRoot, positionScope,
}: {
  forumChannelId: string
  positionScope?: ConversationListScope
  members: Member[]
  mentionCandidates?: ComposerProps["mentionCandidates"]
  observation?: import("@/lib/observability/regions").ResourceObservation
  posts: ForumThread[]
  loading?: boolean
  tag: string
  availableTags?: string[]
  tagsKnown?: boolean
  tagsError?: boolean
  onRetryTags?: () => void
  onTagChange: (tag: string) => void
  hasMore?: boolean
  loadingMore?: boolean
  isFetching?: boolean
  isError?: boolean
  onLoadMore?: () => void
  onOpenPost: (id: string) => void
  // Async — page owns the mutation + `enterThread` navigation and either
  // resolves or rejects. `CreateForumThread` catches rejection to toast and
  // preserve composer state for retry.
  onCreatePost?: (post: NewForumThread) => Promise<void>
  // Save handler for a single post's tags. Absent → tag editing disabled.
  onEditPostTags?: (threadId: string, tags: string[]) => Promise<void> | void
  // Whether the current user may edit a given post's tags (creator or manager).
  canEditPostTags?: (post: ForumThread) => boolean | undefined
  // The post id whose tag save is in flight, if any.
  savingTagsFor?: string | null
  // Delete handler for a single post. Absent → delete disabled.
  onDeletePost?: (post: ForumThread) => void
  // Whether the current user may delete a given post (creator or manager).
  canDeletePost?: (post: ForumThread) => boolean | undefined
  // The post id whose delete is in flight, if any.
  deletingPost?: string | null
  onScrollRoot?: (node: HTMLDivElement | null) => void
}) {
  const desktopActions = useHydratedClient() && getClientPlatform() === "desktop"
  const postActionsClassName = cn(
    "col-start-2 row-start-1 z-10 flex self-center items-center gap-1",
    desktopActions && "opacity-0 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-data-popup-open:opacity-100",
  )
  const profilesByUserId = useCanonicalProfilesByUserId()
  const [composing, setComposing] = useAtom(useCreateAtom(false))
  const [deletingForId, setDeletingForId] = useAtom(useCreateAtom<string | null>(null))
  const deletingFor = posts.find((post) => post.id === deletingForId) ?? null
  const setDeletingFor = (post: ForumThread | null) => setDeletingForId(post?.id ?? null)
  const newPostTriggerRef = useRef<HTMLButtonElement>(null)
  const filterTags = [...new Set(availableTags)]
  const hasArchivedPosts = filterTags.includes(FORUM_ARCHIVE_TAG)
  const displayFilterTags = [
    ...filterTags.filter((candidate) => candidate !== FORUM_ARCHIVE_TAG),
    ...(hasArchivedPosts ? [FORUM_ARCHIVE_TAG] : []),
  ]
  const filterTagKey = filterTags.join("\0")
  const {
    fades: tagFades,
    onKeyDown: onTagRailKeyDown,
    onScroll: onTagRailScroll,
    scrollerRef: tagScrollerRef,
    selectedRef: activeFilterRef,
  } = useHorizontalOverflowRail<HTMLDivElement, HTMLButtonElement>({
    contentKey: filterTagKey,
    selectedKey: tag,
  })

  const closeCompose = () => {
    setComposing(false)
    // Focus returns to the trigger so keyboard/screen-reader users don't lose
    // their place. `queueMicrotask` so the trigger has re-rendered before we
    // reach for its ref.
    queueMicrotask(() => newPostTriggerRef.current?.focus())
  }

  return (
    <>
      {/* Composer OR filter bar in the same slot — swapping (not stacking)
          keeps the post list below anchored. */}
      {composing ? (
        <CreateForumThread
          forumChannelId={forumChannelId}
          members={members}
          mentionCandidates={mentionCandidates}
          onCancel={closeCompose}
          onCreatePost={async (post) => {
            if (!onCreatePost) return
            await onCreatePost(post)
            try { post.assertActive?.() } catch { return }
            closeCompose()
          }}
        />
      ) : (
        <div
          data-testid={tid.forumFilterBar}
          className="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-4 py-2"
        >
          <div className="relative min-w-0 flex-1">
            <div
              ref={tagScrollerRef}
              data-testid={tid.forumTagScroller}
              role="region"
              aria-label="Forum tag filters"
              tabIndex={0}
              onScroll={onTagRailScroll}
              onKeyDown={onTagRailKeyDown}
              className="flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain thin-scrollbar scrollbar-none"
            >
              {!tagsKnown ? tagsError ? (
                <Button variant="ghost" size="sm" type="button" className="h-7 shrink-0 rounded-lg px-2.75 py-1 text-[13px] leading-5 text-muted-foreground hover:text-foreground" onClick={onRetryTags}>Retry tags</Button>
              ) : (
                <div role="status" aria-label="Loading tag filters" className="flex h-7 shrink-0 items-center gap-2">
                  <Skeleton className="h-7 w-16 rounded-lg" /><Skeleton className="h-7 w-20 rounded-lg" /><Skeleton className="h-7 w-16 rounded-lg" />
                </div>
              ) : (
                <>
                  <Button variant="ghost" size="sm"
                    ref={tag === "All" ? activeFilterRef : undefined}
                    type="button"
                    aria-pressed={tag === "All"}
                    data-testid={tid.forumTagAll}
                    className={cn(
                      "shrink-0 rounded-lg px-2.75 py-1 text-[13px] leading-5 transition-colors",
                      tag === "All" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                    onClick={() => onTagChange("All")}
                  >
                    All
                  </Button>
                  {displayFilterTags.map((t) => (
                    <Button variant="ghost" size="sm"
                      key={t}
                      aria-pressed={tag === t}
                      ref={tag === t ? activeFilterRef : undefined}
                      type="button"
                      style={tagColorStyle(t)}
                      className={cn(
                        "shrink-0 rounded-lg px-2.75 py-1 text-[13px] leading-5 transition-opacity",
                        tagColorClassName,
                        tag === t ? "opacity-100 ring-1 ring-inset ring-current/20" : "opacity-70 hover:opacity-100",
                      )}
                      data-testid={tid.forumTagChip(t)}
                      onClick={() => onTagChange(t)}
                    >
                      {t === FORUM_ARCHIVE_TAG ? "Archived" : `#${t}`}
                    </Button>
                  ))}
                </>
              )}
            </div>
            <HorizontalOverflowFadeOverlays
              fades={tagFades}
              leftTestId={tid.forumTagFadeLeft}
              rightTestId={tid.forumTagFadeRight}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button data-testid={tid.forumNewPost} size="sm" ref={newPostTriggerRef} onClick={() => setComposing(true)}><Plus className="size-4" /> New Post</Button>
          </div>
        </div>
      )}

      <ForumPostList
        key={JSON.stringify([forumChannelId, tag])}
        posts={posts} loading={loading} observation={observation} positionScope={positionScope}
        hasMore={hasMore} loadingMore={loadingMore} isFetching={isFetching} isError={isError}
        onLoadMore={onLoadMore} onScrollRoot={onScrollRoot} onOpenPost={onOpenPost} loadingContent={<ForumListSkeleton />}
        renderPost={(p) => {
              const canEdit = onEditPostTags && canEditPostTags ? canEditPostTags(p) : false
              const canDelete = onDeletePost && canDeletePost ? canDeletePost(p) : false
              if (canEdit === undefined || canDelete === undefined) return <ForumPostSkeleton key={p.id} postId={p.id} />
              const archived = p.tags.includes(FORUM_ARCHIVE_TAG)
              const hasOrdinaryTags = p.tags.some((postTag) => postTag !== FORUM_ARCHIVE_TAG)
              const savingTags = savingTagsFor === p.id
              const actionCount = (canEdit ? 2 : 0) + (canDelete ? 1 : 0)
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
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  data-page-swipe-navigation-row=""
                  data-msg-id={p.openerMessageId || undefined}
                  data-testid={tid.forumThreadCard(p.id)}
                  onClick={() => onOpenPost(p.id)}
                  onKeyDown={(event) => {
                    if (!shouldActivateForumRow(event)) return
                    event.preventDefault()
                    onOpenPost(p.id)
                  }}
                  className={cn(
                    "relative cursor-pointer rounded text-left",
                    POST_ROW_CLASS,
                  )}
                >
                  <div className={cn("grid grid-rows-[minmax(2rem,max-content)_auto] gap-x-2", actionCount > 0 ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1")}>
                    <ForumPostTitle name={p.name} postId={p.id} seq={p.parentSeq} />
                    {(canEdit || canDelete) && (
                      <div
                        className={cn(postActionsClassName, deletingForId === p.id && "opacity-100")}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        {canEdit && (
                          <PostTagDialog
                            trigger={(
                              <Button variant="ghost" size="sm"
                                type="button"
                                data-testid={tid.forumThreadTagBtn(p.id)}
                                onClick={(event) => event.stopPropagation()}
                                className={cn(POST_ACTION_CLASS, "hover:bg-accent hover:text-foreground")}
                                aria-label="Edit tags"
                              >
                                <Tag className="size-4" />
                              </Button>
                            )}
                            postName={p.name}
                            current={p.tags}
                            allTags={availableTags}
                            saving={savingTagsFor === p.id}
                            onSave={(tags) => onEditPostTags?.(p.id, tags)}
                          />
                        )}
                        {canEdit && (
                          <Button variant="ghost" size="sm"
                            type="button"
                            data-testid={tid.forumThreadArchiveBtn(p.id)}
                            disabled={savingTags}
                            onClick={(event) => {
                              event.stopPropagation()
                              void Promise.resolve(
                                onEditPostTags?.(p.id, toggleForumArchivedStatus(p.tags)),
                              ).catch(() => undefined)
                            }}
                            className={cn(POST_ACTION_CLASS, "hover:bg-accent hover:text-foreground")}
                            aria-label={archived ? "Unarchive post" : "Archive post"}
                            aria-pressed={archived}
                          >
                            {archived
                              ? <ArchiveRestore aria-hidden="true" className="size-4" />
                              : <Archive aria-hidden="true" className="size-4" />}
                          </Button>
                        )}
                        {canDelete && (
                          <Button variant="ghost" size="sm"
                            type="button"
                            data-testid={tid.forumThreadDeleteBtn(p.id)}
                            disabled={deletingPost === p.id}
                            onClick={(e) => { e.stopPropagation(); setDeletingFor(p) }}
                            className={cn(POST_ACTION_CLASS, "hover:bg-accent hover:text-destructive")}
                            aria-label="Delete post"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    )}

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
                            const profile = readCommunityProfile(
                              profilesByUserId.get(member.id),
                              member.id,
                            )
                            return (
                              <Avatar key={member.id} label={profile.avatar} seed={member.id} size={19} ringColor="var(--background)" />
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
        }}
      />

      {deletingFor && (
        <ConfirmDialog
          open
          onOpenChange={(v) => { if (!v) setDeletingFor(null) }}
          title="Delete post?"
          description={`This permanently deletes “${deletingFor.name}” and all of its replies. This can't be undone.`}
          confirmLabel="Delete post"
          onConfirm={() => { const post = deletingFor; setDeletingFor(null); onDeletePost?.(post) }}
        />
      )}
    </>
  )
}

// Loading placeholder for the forum post list. It mirrors the flat rows so the
// page does not flash back to the old card treatment while data is loading.
function ForumPostSkeleton({ postId }: { postId?: string }) {
  return (
    <div
      data-slot="community-forum-post-skeleton"
      data-testid={postId === undefined ? undefined : tid.forumThreadCard(postId)}
      aria-busy="true"
      aria-label="Loading post"
      className={cn("flex flex-col", POST_ROW_CLASS)}
    >
      <div className="flex min-h-8 items-center"><Skeleton className="h-4 w-2/3 rounded" /></div>
      <div className="mb-2 space-y-2">
        <Skeleton className="h-3 w-full rounded" />
        <Skeleton className="h-3 w-4/5 rounded" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="size-5 rounded-full" />
        <Skeleton className="h-3 w-28 rounded" />
        <Skeleton className="ml-auto h-3 w-10 rounded" />
      </div>
    </div>
  )
}

function ForumListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 3 }).map((_, i) => <ForumPostListItem key={i} first={i === 0}><ForumPostSkeleton /></ForumPostListItem>)}
    </div>
  )
}

// Full-body loading placeholder for the forum route — the filter bar + card
// list mirror <ForumView>'s outer frame so the header + filter bar don't shift
// when the real posts arrive. Used while the channel is still hydrating (i.e.
// before ForumView itself mounts).
export function ForumViewSkeleton() {
  return (
    <>
      <div
        data-testid={tid.forumFilterBar}
        className="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-4 py-2"
      >
        <div className="relative min-w-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain thin-scrollbar scrollbar-none"
          >
            <Skeleton className="h-7 w-10 shrink-0 rounded-lg" />
            <Skeleton className="h-7 w-16 shrink-0 rounded-lg" />
            <Skeleton className="h-7 w-14 shrink-0 rounded-lg" />
            <Skeleton className="h-7 w-20 shrink-0 rounded-lg" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Skeleton className="h-8 w-25 rounded-md" />
        </div>
      </div>
      <main className={`flex-1 overflow-y-auto thin-scrollbar ${FORUM_LIST_SPACING_CLASS}`}>
        <ForumListSkeleton />
      </main>
    </>
  )
}
