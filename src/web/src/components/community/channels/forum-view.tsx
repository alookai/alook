"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { Archive, ArchiveRestore, MessagesSquare, ListChevronsUpDown, Plus, Tag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "@/lib/community/format-time"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "../avatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { EmptyState } from "../empty-state"
import { CreateForumThread, type NewForumThread } from "../messages/create-forum-thread"
import type { ComposerProps } from "../messages/composer"
import { PostTagDialog } from "./post-tag-dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { tid } from "@/lib/community/testids"
import type { ForumThread } from "@/lib/community/models/message"
import type { Member } from "@/lib/community/models/people"
import { VirtualRows } from "../messages/virtual-cursor-list"
import { useVirtualCursorSentinel } from "@/hooks/community/use-virtual-cursor-sentinel"
import { tagColorClassName, tagColorStyle } from "@/lib/community/tag-color"
import { cn } from "@/lib/utils"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import { useProfilesByUserId } from "@/stores/community/ws"
import { readCommunityProfile } from "@/lib/community/profile-read"
import {
  HorizontalOverflowFadeOverlays,
  horizontalOverflowFades,
  useHorizontalOverflowRail,
} from "@/components/horizontal-overflow-rail"

const MAX_AVATARS = 5
const MAX_VISIBLE_TAGS = 2

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
      className="flex min-w-0 items-center gap-1.5 max-sm:order-last max-sm:basis-full max-sm:pl-7"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {shown.map((tag) => <span key={tag} className="max-w-24 truncate">#{tag}</span>)}
      {hidden.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={(
              <button
                type="button"
                className="shrink-0 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                aria-label={`Show ${hidden.length} more tags`}
                onClick={(event) => event.stopPropagation()}
              >
                +{hidden.length}
              </button>
            )}
          />
          <PopoverContent
            side="top"
            align="start"
            className="flex w-52 flex-wrap gap-1.5 p-2"
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

function ForumPostTitle({ name, postId, seq }: { name: string; postId: string; seq?: number }) {
  const hostRef = useRef<HTMLHeadingElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const measureNameRef = useRef<HTMLSpanElement>(null)
  const [rendered, setRendered] = useState({ name, truncated: false })

  useLayoutEffect(() => {
    const host = hostRef.current
    const measure = measureRef.current
    const measureName = measureNameRef.current
    if (!host || !measure || !measureName) return

    const characters = Array.from(name)
    const commit = (nextName: string, truncated: boolean) => {
      setRendered((current) => current.name === nextName && current.truncated === truncated
        ? current
        : { name: nextName, truncated })
    }
    const recompute = () => {
      if (host.clientWidth === 0) return
      const view = measure.ownerDocument?.defaultView
      if (!view) return
      const lineHeight = Number.parseFloat(view.getComputedStyle(measure).lineHeight)
      if (!Number.isFinite(lineHeight)) return
      const fits = (count: number, truncated: boolean) => {
        measureName.textContent = `${characters.slice(0, count).join("")}${truncated ? "…" : ""}`
        return measure.getBoundingClientRect().height <= lineHeight * 2 + 0.5
      }

      if (fits(characters.length, false)) {
        commit(name, false)
        return
      }

      let low = 0
      let high = characters.length
      while (low < high) {
        const midpoint = Math.ceil((low + high) / 2)
        if (fits(midpoint, true)) low = midpoint
        else high = midpoint - 1
      }
      commit(characters.slice(0, low).join(""), true)
    }

    recompute()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(recompute)
    observer.observe(host)
    return () => observer.disconnect()
  }, [name, seq])

  const renderSequence = (measurement = false) => seq === undefined ? null : (
    <span
      data-testid={measurement ? undefined : tid.forumThreadSeq(postId)}
      className="ml-1.5 whitespace-nowrap font-mono text-[13px] font-medium text-muted-foreground"
    >
      <span className="opacity-60">#</span>{seq}
    </span>
  )

  return (
    <h3
      ref={hostRef}
      data-testid={tid.forumThreadTitle(postId)}
      data-truncated={rendered.truncated ? "true" : "false"}
      aria-label={rendered.truncated ? `${name}${seq === undefined ? "" : ` #${seq}`}` : undefined}
      title={rendered.truncated ? name : undefined}
      className="relative line-clamp-2 w-full min-w-0 max-w-full wrap-break-word text-[15px] font-semibold leading-tight"
    >
      <span data-testid={tid.forumThreadTitleText(postId)}>{rendered.name}{rendered.truncated ? "…" : ""}</span>
      {renderSequence()}
      <span
        ref={measureRef}
        aria-hidden
        className="invisible absolute left-0 top-0 block w-full whitespace-normal wrap-break-word text-[15px] font-semibold leading-tight"
      >
        <span ref={measureNameRef}>{name}</span>
        {renderSequence(true)}
      </span>
    </h3>
  )
}

// Forum channel body — rendered under the shared ChannelHeader. A feed of posts;
// each post opens as a thread. The filter bar's tag chips are DERIVED from the
// posts themselves (the deduped union of every post's tags) — there is no
// forum-level tag vocabulary. Per-post tags are edited from a hover icon on each
// card (creator + server managers), not a forum-wide manage mode.
export function ForumView({
  forumChannelId,
  members,
  mentionCandidates,
  posts, loading, tag, availableTags = [], onTagChange, onOpenPost, onCreatePost, onEditPostTags, canEditPostTags, savingTagsFor,
  hasMore, loadingMore, onLoadMore,
  onDeletePost, canDeletePost, deletingPost,
  onScrollRoot,
}: {
  forumChannelId: string
  members: Member[]
  mentionCandidates?: ComposerProps["mentionCandidates"]
  posts: ForumThread[]
  loading?: boolean
  tag: string
  availableTags?: string[]
  onTagChange: (tag: string) => void
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  onOpenPost: (id: string) => void
  // Async — page owns the mutation + `enterThread` navigation and either
  // resolves or rejects. `CreateForumThread` catches rejection to toast and
  // preserve composer state for retry.
  onCreatePost?: (post: NewForumThread) => Promise<void>
  // Save handler for a single post's tags. Absent → tag editing disabled.
  onEditPostTags?: (threadId: string, tags: string[]) => Promise<void> | void
  // Whether the current user may edit a given post's tags (creator or manager).
  canEditPostTags?: (post: ForumThread) => boolean
  // The post id whose tag save is in flight, if any.
  savingTagsFor?: string | null
  // Delete handler for a single post. Absent → delete disabled.
  onDeletePost?: (post: ForumThread) => void
  // Whether the current user may delete a given post (creator or manager).
  canDeletePost?: (post: ForumThread) => boolean
  // The post id whose delete is in flight, if any.
  deletingPost?: string | null
  onScrollRoot?: (node: HTMLDivElement | null) => void
}) {
  const profilesByUserId = useProfilesByUserId()
  const [composing, setComposing] = useState(false)
  const [deletingFor, setDeletingFor] = useState<ForumThread | null>(null)
  const newPostTriggerRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bindScrollRoot = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    onScrollRoot?.(node)
  }, [onScrollRoot])
  const alignedTagRef = useRef<string | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- library limitation, same as member-list.tsx
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: posts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 128,
    getItemKey: (index) => posts[index]?.id ?? index,
    overscan: 5,
    initialRect: { width: 0, height: 800 },
  })
  const filterTags = availableTags.length > 0
    ? availableTags
    : [...new Set(posts.flatMap((post) => post.tags))]
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
  useLayoutEffect(() => {
    if (posts.length === 0 || alignedTagRef.current === tag) return
    alignedTagRef.current = tag
    virtualizer.scrollToIndex(0, { align: "start" })
  }, [posts.length, tag, virtualizer])
  const olderSentinelRef = useVirtualCursorSentinel({
    scrollRef,
    hasMore,
    isFetching: loadingMore,
    onLoad: onLoadMore,
    edge: "end",
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
              {filterTags.length > 0 && (
                <>
                  <button
                    ref={tag === "All" ? activeFilterRef : undefined}
                    type="button"
                    data-testid={tid.forumTagAll}
                    className={cn(
                      "shrink-0 rounded-lg px-2.75 py-1 text-[13px] leading-5 transition-colors",
                      tag === "All" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    )}
                    onClick={() => onTagChange("All")}
                  >
                    All
                  </button>
                  {displayFilterTags.map((t) => (
                    <button
                      key={t}
                      ref={tag === t ? activeFilterRef : undefined}
                      type="button"
                      style={tagColorStyle(t)}
                      className={cn(
                        "shrink-0 rounded-lg px-2.75 py-1 text-[13px] leading-5 transition-opacity",
                        tagColorClassName,
                        tag === t ? "opacity-100 ring-1 ring-current/20" : "opacity-70 hover:opacity-100",
                      )}
                      data-testid={tid.forumTagChip(t)}
                      onClick={() => onTagChange(t)}
                    >
                      {t === FORUM_ARCHIVE_TAG ? "Archived" : `#${t}`}
                    </button>
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

      <div
        ref={bindScrollRoot}
        role="main"
        data-testid={tid.forumPostList}
        className="flex-1 overflow-y-auto thin-scrollbar px-0 py-2 sm:px-4"
      >
        {loading && posts.length === 0 ? (
          <ForumListSkeleton />
        ) : posts.length === 0 ? (
          <EmptyState icon={ListChevronsUpDown} label="No posts with this tag yet. Start one with New Post." />
        ) : (
          <>
            <VirtualRows
              items={posts}
              virtualizer={virtualizer}
              itemKey={(post) => post.id}
              renderItem={(p, index) => {
              const canEdit = !!onEditPostTags && (canEditPostTags?.(p) ?? false)
              const canDelete = !!onDeletePost && (canDeletePost?.(p) ?? false)
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
                  data-msg-id={p.openerMessageId || undefined}
                  data-testid={tid.forumThreadCard(p.id)}
                  onClick={() => onOpenPost(p.id)}
                  onKeyDown={(event) => {
                    if (!shouldActivateForumRow(event)) return
                    event.preventDefault()
                    onOpenPost(p.id)
                  }}
                  className={cn(
                    "group/card relative cursor-pointer rounded border-b border-border/50 px-4.5 py-3.5 text-left transition-colors hover:bg-accent/45",
                    index === posts.length - 1 && "border-b-0",
                  )}
                >
                  {(canEdit || canDelete) && (
                    <div
                      className="absolute right-3 top-3 z-10 flex items-center gap-1"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {canEdit && (
                        <PostTagDialog
                          trigger={(
                            <button
                              type="button"
                              data-testid={tid.forumThreadTagBtn(p.id)}
                              onClick={(event) => event.stopPropagation()}
                              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity hover:bg-accent hover:text-foreground sm:size-6 sm:opacity-0 sm:focus-visible:opacity-100 sm:data-popup-open:opacity-100 sm:group-hover/card:opacity-100"
                              aria-label="Edit tags"
                            >
                              <Tag className="size-4" />
                            </button>
                          )}
                          postName={p.name}
                          current={p.tags}
                          allTags={availableTags}
                          saving={savingTagsFor === p.id}
                          onSave={(tags) => onEditPostTags?.(p.id, tags)}
                        />
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          data-testid={tid.forumThreadArchiveBtn(p.id)}
                          disabled={savingTags}
                          onClick={(event) => {
                            event.stopPropagation()
                            void Promise.resolve(
                              onEditPostTags?.(p.id, toggleForumArchivedStatus(p.tags)),
                            ).catch(() => undefined)
                          }}
                          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity hover:bg-accent hover:text-foreground sm:size-6 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover/card:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={archived ? "Unarchive post" : "Archive post"}
                          aria-pressed={archived}
                        >
                          {archived
                            ? <ArchiveRestore aria-hidden="true" className="size-4" />
                            : <Archive aria-hidden="true" className="size-4" />}
                        </button>
                      )}
                      {canDelete && (
                      <button
                        type="button"
                        data-testid={tid.forumThreadDeleteBtn(p.id)}
                        disabled={deletingPost === p.id}
                        onClick={(e) => { e.stopPropagation(); setDeletingFor(p) }}
                        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground opacity-100 transition-opacity hover:bg-accent hover:text-destructive sm:size-6 sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover/card:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Delete post"
                      >
                        <Trash2 className="size-4" />
                      </button>
                      )}
                    </div>
                  )}

                  <div className={cn(
                    actionCount === 3 && "min-h-8 pr-28 sm:min-h-0 sm:pr-22",
                    actionCount === 2 && "min-h-8 pr-20 sm:min-h-0 sm:pr-16",
                    actionCount === 1 && "min-h-8 pr-12 sm:min-h-0 sm:pr-8",
                    actionCount === 0 && "pr-0",
                  )}>
                    <ForumPostTitle name={p.name} postId={p.id} seq={p.parentSeq} />
                  </div>
                  <p className="mb-2.25 mt-0.75 line-clamp-2 text-[13.5px] text-muted-foreground">{p.preview}</p>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
                    <Avatar label={author.avatar} seed={p.authorId} size={20} />
                    <span className="shrink-0 font-medium text-foreground" suppressHydrationWarning>{author.name}</span>
                    <span className="shrink-0" aria-hidden>·</span>
                    <span className="shrink-0" suppressHydrationWarning>{formatRelativeTime(p.lastMessageAt)}</span>
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
            <div ref={olderSentinelRef} className="h-px" aria-hidden />
          </>
        )}
      </div>

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
function ForumListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col border-b border-border/50 px-4.5 py-3.5 last:border-b-0">
          <Skeleton className="h-4 w-2/3 rounded" />
          <div className="mb-2.25 mt-1.25 space-y-1.5">
            <Skeleton className="h-3 w-full rounded" />
            <Skeleton className="h-3 w-4/5 rounded" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-3 w-28 rounded" />
            <Skeleton className="ml-auto h-3 w-10 rounded" />
          </div>
        </div>
      ))}
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
      <div className="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b border-border px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <div
            aria-hidden
            className="pointer-events-none flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain thin-scrollbar scrollbar-none sm:flex-wrap sm:overflow-x-visible"
          >
            <Skeleton className="h-7 w-10 shrink-0 rounded-full" />
            <Skeleton className="h-7 w-16 shrink-0 rounded-full" />
            <Skeleton className="h-7 w-14 shrink-0 rounded-full" />
            <Skeleton className="h-7 w-20 shrink-0 rounded-full" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Skeleton className="h-8 w-25 rounded-md" />
        </div>
      </div>
      <main className="flex-1 overflow-y-auto thin-scrollbar px-0 py-2 sm:px-4">
        <ForumListSkeleton />
      </main>
    </>
  )
}
