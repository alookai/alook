"use client"

import { useEffect, useState } from "react"
import { Plus, ChevronLeft, Menu, MessagesSquare, Tags, X, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { formatRelativeTime } from "./format-time"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Avatar } from "./avatar"
import { EmptyState } from "./empty-state"
import { CreateForumPost, type NewForumPost } from "./create-forum-post"
import type { ForumPost } from "./_types"

// Forum channel view — a feed of posts; each post opens as a thread. `tags` seeds the
// available tag chips ("All" + tag names); tags can be added/removed in manage mode.
// Clicking New Post opens an inline composer.
export function ForumView({
  channel, posts, tags, onOpenPost, onCreatePost, onTagsChanged, canManageTags, onHamburger, onBack,
}: {
  channel: string
  posts: ForumPost[]
  tags: string[]
  onOpenPost: (id: string) => void
  onCreatePost?: (post: NewForumPost) => void
  onTagsChanged?: (tags: string[]) => void
  canManageTags?: boolean
  onHamburger?: () => void
  onBack?: () => void
}) {
  const [tag, setTag] = useState("All")
  const [composing, setComposing] = useState(false)
  const [tagList, setTagList] = useState<string[]>(() => tags.filter((t) => t !== "All"))
  useEffect(() => { setTagList(tags.filter((t) => t !== "All")) }, [tags])
  const [managing, setManaging] = useState(false)
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
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
        )}
        {onHamburger && (
          <Button variant="ghost" size="icon-sm" onClick={onHamburger} className="text-muted-foreground hover:text-foreground" aria-label="Open channels"><Menu className="size-5" /></Button>
        )}
        <MessagesSquare className="ml-1 size-6 text-muted-foreground" />
        <h1 className="truncate text-base font-medium">{channel}</h1>
        <div className="ml-auto flex items-center gap-1">
          {canManageTags && <Button
            variant="ghost"
            size="icon-sm"
            className={`text-muted-foreground hover:text-foreground ${managing ? "bg-accent text-foreground" : ""}`}
            aria-label="Manage tags"
            onClick={() => setManaging((v) => !v)}
          >
            <Tags className="size-5" />
          </Button>}
          <Button size="sm" onClick={() => setComposing(true)}><Plus className="size-4" /> New Post</Button>
        </div>
      </header>

      {composing && (
        <CreateForumPost
          tags={tagList}
          onCancel={() => setComposing(false)}
          onPost={(post) => { onCreatePost?.(post); setComposing(false) }}
        />
      )}

      {/* tag filter chips (+ manage mode: delete chips, add a new tag) */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
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

      <main className="flex-1 overflow-y-auto thin-scrollbar p-4">
        {filtered.length === 0 ? (
          <EmptyState icon={MessagesSquare} label="No posts with this tag yet. Start one with New Post." />
        ) : (
          <div className="flex flex-col gap-2.5">
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
