"use client"

import { useLayoutEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { COMMUNITY_VIRTUALIZER_REACT_OPTIONS } from "@/hooks/community/virtualizer-react-options"
import { MessagesSquare, ListChevronsUpDown, Plus, Tag, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "./format-time"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { EmptyState } from "./empty-state"
import { CreateForumThread, type NewForumThread } from "./create-forum-thread"
import { PostTagDialog } from "./post-tag-dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { tid } from "@/lib/community/testids"
import type { ForumThread, Member } from "./_types"
import { VirtualRows } from "./virtual-cursor-list"
import { useVirtualCursorSentinel } from "@/hooks/community/use-virtual-cursor-sentinel"

// Max member avatars shown in a post card's AvatarGroup before collapsing to a
// "+N" bubble. Creator is always first.
const MAX_AVATARS = 5

// Forum channel body — rendered under the shared ChannelHeader. A feed of posts;
// each post opens as a thread. The filter bar's tag chips are DERIVED from the
// posts themselves (the deduped union of every post's tags) — there is no
// forum-level tag vocabulary. Per-post tags are edited from a hover icon on each
// card (creator + server managers), not a forum-wide manage mode.
export function ForumView({
  forumChannelId,
  members,
  onSearchMembers,
  posts, loading, tag, availableTags = [], onTagChange, onOpenPost, onCreatePost, onEditPostTags, canEditPostTags, savingTagsFor,
  hasMore, loadingMore, onLoadMore,
  onDeletePost, canDeletePost, deletingPost,
}: {
  forumChannelId: string
  members: Member[]
  onSearchMembers?: (query: string) => void
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
  onEditPostTags?: (threadId: string, tags: string[]) => void
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
}) {
  const [composing, setComposing] = useState(false)
  const [editingTagsFor, setEditingTagsFor] = useState<ForumThread | null>(null)
  const [deletingFor, setDeletingFor] = useState<ForumThread | null>(null)
  const newPostTriggerRef = useRef<HTMLButtonElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const alignedTagRef = useRef<string | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- library limitation, same as member-list.tsx
  const virtualizer = useVirtualizer({
    ...COMMUNITY_VIRTUALIZER_REACT_OPTIONS,
    count: posts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    getItemKey: (index) => posts[index]?.id ?? index,
    overscan: 5,
    initialRect: { width: 0, height: 800 },
  })
  const filterTags = availableTags.length > 0
    ? availableTags
    : [...new Set(posts.flatMap((post) => post.tags))]
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
          onSearchMembers={onSearchMembers}
          onCancel={closeCompose}
          onCreatePost={async (post) => {
            if (!onCreatePost) return
            await onCreatePost(post)
            closeCompose()
          }}
        />
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {filterTags.length > 0 && (
              <>
                <Badge variant={tag === "All" ? "default" : "secondary"} className="shrink-0 cursor-pointer" render={<button onClick={() => onTagChange("All")} />}>All</Badge>
                {filterTags.map((t) => (
                  <Badge
                    key={t}
                    variant={tag === t ? "default" : "secondary"}
                    className="shrink-0 cursor-pointer"
                    data-testid={tid.forumTagChip(t)}
                    render={<button onClick={() => onTagChange(t)} />}
                  >
                    {`#${t}`}
                  </Badge>
                ))}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" ref={newPostTriggerRef} onClick={() => setComposing(true)}><Plus className="size-4" /> New Post</Button>
          </div>
        </div>
      )}

      <div ref={scrollRef} role="main" className="flex-1 overflow-y-auto thin-scrollbar p-4">
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
              renderItem={(p) => {
              const canEdit = !!onEditPostTags && (canEditPostTags?.(p) ?? false)
              const canDelete = !!onDeletePost && (canDeletePost?.(p) ?? false)
              const others = p.participants.filter((m) => m.id !== p.authorId)
              const shown = others.slice(0, MAX_AVATARS)
              const overflow = Math.max(0, p.participantCount - 1 - shown.length)
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  data-testid={tid.forumThreadCard(p.id)}
                  onClick={() => onOpenPost(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPost(p.id) } }}
                  className="group/card mb-3 flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <div className="flex items-center gap-2">
                    <Avatar label={p.authorAvatar} seed={p.authorId} size={24} />
                    <span className="text-xs font-medium text-foreground" suppressHydrationWarning>{p.parent.authorName || "Unknown"}</span>
                    <span className="text-xs text-muted-foreground" suppressHydrationWarning>· {formatRelativeTime(p.lastMessageAt)}</span>
                    {others.length > 0 && (
                      <>
                        <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
                        <AvatarGroup data-testid={tid.forumThreadAvatars(p.id)}>
                          {shown.map((m) => (
                            <Avatar key={m.id} label={m.avatar} seed={m.id} size={24} ringColor="var(--card)" />
                          ))}
                          {overflow > 0 && <AvatarGroupCount className="size-6 text-[11px]">+{overflow}</AvatarGroupCount>}
                        </AvatarGroup>
                      </>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        data-testid={tid.forumThreadTagBtn(p.id)}
                        onClick={(e) => { e.stopPropagation(); setEditingTagsFor(p) }}
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
                        aria-label="Edit tags"
                      >
                        <Tag className="size-4" />
                      </button>
                    )}
                    {canDelete && (
                      <button
                        type="button"
                        data-testid={tid.forumThreadDeleteBtn(p.id)}
                        disabled={deletingPost === p.id}
                        onClick={(e) => { e.stopPropagation(); setDeletingFor(p) }}
                        className={`${canEdit ? "" : "ml-auto "}grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100 disabled:cursor-not-allowed disabled:opacity-50`}
                        aria-label="Delete post"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                  <h3 className="line-clamp-1 text-[15px] font-semibold leading-tight">{p.name}</h3>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{p.preview}</p>
                  <div className="flex items-center gap-2">
                    {p.tags.length > 0 && p.tags.map((t) => (
                      <Badge key={t} variant="secondary">#{t}</Badge>
                    ))}
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <MessagesSquare className="size-3.5" /> {Math.max(0, p.messageCount)}
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

      {editingTagsFor && (
        <PostTagDialog
          open
          onOpenChange={(v) => { if (!v) setEditingTagsFor(null) }}
          postName={editingTagsFor.name}
          current={editingTagsFor.tags}
          allTags={availableTags}
          saving={savingTagsFor === editingTagsFor.id}
          onSave={(tags) => { onEditPostTags?.(editingTagsFor.id, tags); setEditingTagsFor(null) }}
        />
      )}

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

// Loading placeholder for the forum post list — three card placeholders that
// match <ForumView>'s post-card density so the filter bar above doesn't shift
// when posts arrive.
function ForumListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-3 w-40 rounded" />
          </div>
          <Skeleton className="h-4 w-2/3 rounded" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-full rounded" />
            <Skeleton className="h-3 w-5/6 rounded" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-full" />
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
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-10 rounded-full" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-14 rounded-full" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Skeleton className="h-8 w-25 rounded-md" />
        </div>
      </div>
      <main className="flex-1 overflow-y-auto thin-scrollbar p-4">
        <ForumListSkeleton />
      </main>
    </>
  )
}
