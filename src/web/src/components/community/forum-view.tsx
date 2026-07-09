"use client"

import { useEffect, useState } from "react"
import { MessagesSquare, ListChevronsUpDown, Plus, Tags, X, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "./format-time"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import { CreateForumPost, type NewForumPost } from "./create-forum-post"
import type { ForumPost } from "./_types"

// Forum channel body — rendered under the shared ChannelHeader. A feed of posts;
// each post opens as a thread. The forum-specific actions (New post + Manage tags)
// live here in the filter bar, keeping the header identical to other channels.
// `tags` seeds the available tag chips ("All" + tag names); tags can be added/removed
// in manage mode.
export function ForumView({
  posts, tags, loading, onOpenPost, onCreatePost, onTagsChanged, canManageTags,
}: {
  posts: ForumPost[]
  tags: string[]
  loading?: boolean
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumPost) => void
  onTagsChanged?: (tags: string[]) => void
  canManageTags?: boolean
}) {
  const [tag, setTag] = useState("All")
  const [composing, setComposing] = useState(false)
  const [managing, setManaging] = useState(false)
  const [tagList, setTagList] = useState<string[]>(() => tags.filter((t) => t !== "All"))
  useEffect(() => { setTagList(tags.filter((t) => t !== "All")) }, [tags])
  const [newTag, setNewTag] = useState("")

  const addTag = () => {
    const t = newTag.trim().toLowerCase()
    if (!t || tagList.includes(t)) { setNewTag(""); return }
    const next = [...tagList, t]
    setTagList(next)
    setNewTag("")
    onTagsChanged?.(next)
  }
  const removeTag = (t: string) => {
    const next = tagList.filter((x) => x !== t)
    setTagList(next)
    if (tag === t) setTag("All")
    onTagsChanged?.(next)
  }

  const filtered = tag === "All" ? posts : posts.filter((p) => p.tags.includes(tag))
  return (
    <>
      {composing && (
        <CreateForumPost
          tags={tagList}
          onCancel={() => setComposing(false)}
          onPost={(post) => { onCreatePost?.(post); setComposing(false) }}
        />
      )}

      {/* filter bar — tag chips on the left, forum actions on the right.
          Manage mode swaps the chips for delete/add-tag controls. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {!managing && (
            <Badge variant={tag === "All" ? "default" : "secondary"} className="shrink-0 cursor-pointer" render={<button onClick={() => setTag("All")} />}>All</Badge>
          )}
          {tagList.map((t) => (
            managing ? (
              <Badge key={t} variant="secondary" className="shrink-0 gap-1">
                #{t}
                <button onClick={() => removeTag(t)} className="grid size-3.5 place-items-center rounded-full hover:bg-foreground/10" aria-label={`Delete tag ${t}`}><X className="size-3" /></button>
              </Badge>
            ) : (
              <Badge
                key={t}
                variant={tag === t ? "default" : "secondary"}
                className="shrink-0 cursor-pointer"
                render={<button onClick={() => setTag(t)} />}
              >
                {`#${t}`}
              </Badge>
            )
          ))}
          {managing && (
            <div className="flex items-center gap-1">
              <Input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addTag() }}
                placeholder="new-tag"
                className="h-6 w-28 px-2 text-xs"
              />
              <button onClick={addTag} disabled={!newTag.trim()} className="grid size-6 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="Add tag"><Check className="size-3.5" /></button>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canManageTags && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setManaging((v) => !v)}
              aria-label="Manage tags"
              className={`text-muted-foreground hover:text-foreground ${managing ? "bg-accent text-foreground" : ""}`}
            >
              <Tags className="size-4" />
            </Button>
          )}
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
            {filtered.map((p) => (
              <button
                key={p.id}
                onClick={() => onOpenPost(p.id)}
                className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="flex items-center gap-2">
                  <Avatar label={p.authorAvatar} size={24} />
                  <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                    <span className="font-medium text-foreground">{p.parent.authorName}</span> · {formatRelativeTime(p.lastMessageAt)}
                  </span>
                </div>
                <h3 className="text-[15px] font-semibold leading-tight">{p.name}</h3>
                <p className="line-clamp-2 text-sm text-muted-foreground">{p.preview}</p>
                <div className="flex items-center gap-2">
                  {p.tags.map((t) => (
                    <Badge key={t} variant="secondary">#{t}</Badge>
                  ))}
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <MessagesSquare className="size-3.5" /> {p.messageCount}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
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
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-8 w-25 rounded-md" />
        </div>
      </div>
      <main className="flex-1 overflow-y-auto thin-scrollbar p-4">
        <ForumListSkeleton />
      </main>
    </>
  )
}
