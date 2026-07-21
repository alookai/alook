"use client"

import { useState } from "react"
import { MessagesSquare, ListChevronsUpDown, Plus, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "./format-time"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { EmptyState } from "./empty-state"
import { CreateForumPost, type NewForumPost } from "./create-forum-post"
import { PostTagDialog } from "./post-tag-dialog"
import { tid } from "@/lib/community/testids"
import type { ForumPost } from "./_types"

// Max member avatars shown in a post card's AvatarGroup before collapsing to a
// "+N" bubble. Creator is always first.
const MAX_AVATARS = 4

// Forum channel body — rendered under the shared ChannelHeader. A feed of posts;
// each post opens as a thread. The filter bar's tag chips are DERIVED from the
// posts themselves (the deduped union of every post's tags) — there is no
// forum-level tag vocabulary. Per-post tags are edited from a hover icon on each
// card (creator + server managers), not a forum-wide manage mode.
export function ForumView({
  posts, loading, onOpenPost, onCreatePost, onEditPostTags, canEditPostTags, savingTagsFor,
}: {
  posts: ForumPost[]
  loading?: boolean
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumPost) => void
  // Save handler for a single post's tags. Absent → tag editing disabled.
  onEditPostTags?: (postId: string, tags: string[]) => void
  // Whether the current user may edit a given post's tags (creator or manager).
  canEditPostTags?: (post: ForumPost) => boolean
  // The post id whose tag save is in flight, if any.
  savingTagsFor?: string | null
}) {
  const [tag, setTag] = useState("All")
  const [composing, setComposing] = useState(false)
  const [editingTagsFor, setEditingTagsFor] = useState<ForumPost | null>(null)

  // Deduped union of every post's tags — the forum's tag list is derived, not
  // stored. Only rendered when non-empty.
  const allTags = [...new Set(posts.flatMap((p) => p.tags))].sort()

  const filtered = tag === "All" ? posts : posts.filter((p) => p.tags.includes(tag))
  return (
    <>
      {composing && (
        <CreateForumPost
          onCancel={() => setComposing(false)}
          onPost={(post) => { onCreatePost?.(post); setComposing(false) }}
        />
      )}

      {/* filter bar — derived tag chips on the left (hidden when there are no
          tags anywhere), New Post on the right. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {allTags.length > 0 && (
            <>
              <Badge variant={tag === "All" ? "default" : "secondary"} className="shrink-0 cursor-pointer" render={<button onClick={() => setTag("All")} />}>All</Badge>
              {allTags.map((t) => (
                <Badge
                  key={t}
                  variant={tag === t ? "default" : "secondary"}
                  className="shrink-0 cursor-pointer"
                  data-testid={tid.forumTagChip(t)}
                  render={<button onClick={() => setTag(t)} />}
                >
                  {`#${t}`}
                </Badge>
              ))}
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" onClick={() => setComposing(true)}><Plus className="size-4" /> New Post</Button>
        </div>
      </div>

      <main className="flex-1 overflow-y-auto thin-scrollbar p-4">
        {loading && posts.length === 0 ? (
          <ForumListSkeleton />
        ) : filtered.length === 0 ? (
          <EmptyState icon={ListChevronsUpDown} label="No posts with this tag yet. Start one with New Post." />
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map((p) => {
              const canEdit = !!onEditPostTags && (canEditPostTags?.(p) ?? false)
              const others = p.participants.filter((m) => m.id !== p.authorId)
              const shown = others.slice(0, MAX_AVATARS)
              const overflow = others.length - shown.length
              return (
                <div
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  data-testid={tid.forumPostCard(p.id)}
                  onClick={() => onOpenPost(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPost(p.id) } }}
                  className="group/card flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                >
                  <div className="flex items-center gap-2">
                    <Avatar label={p.authorAvatar} seed={p.authorId} size={24} />
                    <span className="text-xs font-medium text-foreground" suppressHydrationWarning>{p.parent.authorName || "Unknown"}</span>
                    <span className="text-xs text-muted-foreground" suppressHydrationWarning>· {formatRelativeTime(p.lastMessageAt)}</span>
                    {others.length > 0 && (
                      <>
                        <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
                        <AvatarGroup data-testid={tid.forumPostAvatars(p.id)}>
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
                        data-testid={tid.forumPostTagBtn(p.id)}
                        onClick={(e) => { e.stopPropagation(); setEditingTagsFor(p) }}
                        className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
                        aria-label="Edit tags"
                      >
                        <Tag className="size-4" />
                      </button>
                    )}
                  </div>
                  <h3 className="text-[15px] font-semibold leading-tight">{p.name}</h3>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{p.preview}</p>
                  <div className="flex items-center gap-2">
                    {p.tags.length > 0 && p.tags.map((t) => (
                      <Badge key={t} variant="secondary">#{t}</Badge>
                    ))}
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <MessagesSquare className="size-3.5" /> {p.messageCount}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {editingTagsFor && (
        <PostTagDialog
          open
          onOpenChange={(v) => { if (!v) setEditingTagsFor(null) }}
          postName={editingTagsFor.name}
          current={editingTagsFor.tags}
          allTags={allTags}
          saving={savingTagsFor === editingTagsFor.id}
          onSave={(tags) => { onEditPostTags?.(editingTagsFor.id, tags); setEditingTagsFor(null) }}
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
