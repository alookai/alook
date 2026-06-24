"use client"

import { useState } from "react"
import { X, ImagePlus, Smile } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmojiPickerPopover } from "./emoji-picker"

export type NewForumPost = { name: string; content: string; tags: string[] }

// Inline forum-post composer — Title + body + tag chips + Post (Discord forum layout).
// Lives at the top of the forum feed while composing. `tags` are the channel's
// available tags (without the "All" filter sentinel).
export function CreateForumPost({ tags, onCancel, onPost, onAttach }: {
  tags: string[]
  onCancel: () => void
  onPost: (post: NewForumPost) => void
  onAttach?: () => void
}) {
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [selected, setSelected] = useState<string[]>([])

  const toggleTag = (t: string) =>
    setSelected((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  const submit = () => {
    const name = title.trim()
    if (!name) return
    onPost({ name, content: body.trim(), tags: selected })
  }

  return (
    <div className="m-3 overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start gap-3 p-3">
        <button onClick={onCancel} className="mt-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Cancel post">
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Enter a message…"
            rows={2}
            className="mt-1 w-full resize-none bg-transparent text-[15px] leading-[1.4] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button onClick={onAttach} className="grid size-12 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground hover:text-foreground" aria-label="Add image">
          <ImagePlus className="size-5" />
        </button>
      </div>

      {/* tag chips — toggle which tags this post carries */}
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
        {tags.map((t) => (
          <Badge
            key={t}
            variant={selected.includes(t) ? "default" : "secondary"}
            className="cursor-pointer"
            render={<button onClick={() => toggleTag(t)} />}
          >
            #{t}
          </Badge>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <EmojiPickerPopover side="top" align="start" onPick={(e) => setBody((b) => b + e)}>
          <button className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
            <Smile className="size-5" />
          </button>
        </EmojiPickerPopover>
        <Button size="sm" onClick={submit} disabled={!title.trim()}>Post</Button>
      </div>
    </div>
  )
}
