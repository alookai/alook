"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useRef } from "react"
import { ArchiveRestore, Archive, Plus, Tag, Trash2 } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateForumThread, type NewForumThread } from "../messages/create-forum-thread"
import type { ComposerProps } from "../messages/composer"
import { PostTagDialog } from "./post-tag-dialog"
import { ForumPostItem } from "./forum-post-item"
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
import { useHorizontalOverflowRail } from "@/components/horizontal-overflow-rail"

const POST_ACTION_CLASS = "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
const POST_ROW_CLASS = "px-4 py-0"

export function toggleForumArchivedStatus(tags: string[]): string[] {
  const ordinaryTags = tags.filter((tag) => tag !== FORUM_ARCHIVE_TAG)
  return tags.includes(FORUM_ARCHIVE_TAG)
    ? ordinaryTags
    : [...ordinaryTags, FORUM_ARCHIVE_TAG]
}

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

  onEditPostTags?: (threadId: string, tags: string[]) => Promise<void> | void
  // Whether the current user may edit a given post's tags (creator or manager).
  canEditPostTags?: (post: ForumThread) => boolean | undefined

  savingTagsFor?: string | null

  onDeletePost?: (post: ForumThread) => void
  // Whether the current user may delete a given post (creator or manager).
  canDeletePost?: (post: ForumThread) => boolean | undefined

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
    onKeyDown: onTagRailKeyDown,
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
              onKeyDown={onTagRailKeyDown}
              className="flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain scroll-fade-x scroll-fade-4 scroll-px-4 px-4 thin-scrollbar scrollbar-none [&_button]:focus-visible:ring-inset"
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
              const savingTags = savingTagsFor === p.id
              const actions = canEdit || canDelete ? (
              <div
                className={cn(postActionsClassName, deletingForId === p.id && "opacity-100")}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {canEdit && (
                  <PostTagDialog
                    trigger={(
                      <Button variant="ghost" size="icon"
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
                  <Button variant="ghost" size="icon"
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
                  <Button variant="ghost" size="icon"
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
              ) : undefined
              return <ForumPostItem key={p.id} post={p} profilesByUserId={profilesByUserId} onOpen={() => onOpenPost(p.id)} actions={actions} />
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
            className="pointer-events-none flex w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain scroll-fade-x scroll-fade-4 scroll-px-4 px-4 thin-scrollbar scrollbar-none"
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
      <main className={`flex-1 overflow-y-auto thin-scrollbar scroll-fade-y scroll-fade-4 ${FORUM_LIST_SPACING_CLASS}`}>
        <ForumListSkeleton />
      </main>
    </>
  )
}
