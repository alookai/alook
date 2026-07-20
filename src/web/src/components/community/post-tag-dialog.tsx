"use client"

import { useState } from "react"
import { X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { onEnterSubmit } from "@/lib/ime"
import { tid } from "@/lib/community/testids"

// Per-post tag editor. Opened from the tag icon on a post card. Shows the
// forum's existing tags (the deduped union across posts, passed as `allTags`)
// as toggle chips, plus a free-text input to add a brand-new tag. Saving PATCHes
// the post's tag list. There is no forum-level tag vocabulary anymore — a new
// tag simply exists on this post and joins the union once it lands.
export function PostTagDialog({
  open,
  onOpenChange,
  postName,
  current,
  allTags,
  onSave,
  saving,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  postName: string
  current: string[]
  allTags: string[]
  onSave: (tags: string[]) => void
  saving?: boolean
}) {
  const [selected, setSelected] = useState<string[]>(current)
  const [draft, setDraft] = useState("")

  const toggle = (t: string) =>
    setSelected((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))

  const addDraft = () => {
    const t = draft.trim().toLowerCase()
    setDraft("")
    if (!t || selected.includes(t)) return
    setSelected((prev) => [...prev, t])
  }

  // The chip set is the union of the forum's known tags and anything selected
  // (so a freshly-typed tag shows as an active chip too), stable-sorted.
  const chips = [...new Set([...allTags, ...selected])].sort()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid={tid.forumTagDialog}>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>Tag “{postName}” to help others find it.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          {chips.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tags yet. Add the first one below.</p>
          ) : (
            chips.map((t) => (
              <Badge
                key={t}
                variant={selected.includes(t) ? "default" : "secondary"}
                className="cursor-pointer"
                render={<button type="button" onClick={() => toggle(t)} />}
              >
                {`#${t}`}
                {selected.includes(t) && <X className="ml-1 size-3" />}
              </Badge>
            ))
          )}
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onEnterSubmit(addDraft)}
            placeholder="new-tag"
            className="h-9"
          />
          <Button type="button" variant="secondary" size="sm" onClick={addDraft} disabled={!draft.trim()}>
            Add
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button data-testid={tid.forumTagDialogSave} onClick={() => onSave(selected)} disabled={saving}>Save tags</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
