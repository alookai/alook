"use client"

import { useState } from "react"
import { X, Smile } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmojiPickerPopover } from "./emoji-picker"

export type NewForumPost = { name: string; content: string; tags: string[] }

export function CreateForumPost({ tags, onCancel, onPost }: {
  tags: string[]
  onCancel: () => void
  onPost: (post: NewForumPost) => void
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
            className="mt-1 w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* tag chips */}
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
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
      )}

      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <EmojiPickerPopover side="top" align="start" onPick={(e) => setBody((b) => b + e)}>
          <button className="grid size-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
            <Smile className="size-5" />
          </button>
        </EmojiPickerPopover>
        <Button size="sm" onClick={submit} disabled={!title.trim() || !body.trim()}>Post</Button>
      </div>
    </div>
  )
}
