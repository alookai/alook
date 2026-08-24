"use client"

import { useEffect, useState, type ReactElement } from "react"
import { X } from "lucide-react"
import { MAX_FORUM_TAG_LENGTH, MAX_FORUM_TAGS_PER_POST } from "@alook/shared"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import { onEnterSubmit } from "@/lib/ime"
import { tid } from "@/lib/community/testids"
import { tagColorClassName, tagColorStyle } from "@/lib/community/tag-color"
import { cn } from "@/lib/utils"

export function PostTagDialog({
  trigger,
  postName,
  current,
  allTags,
  onSave,
  saving,
}: {
  trigger: ReactElement
  postName: string
  current: string[]
  allTags: string[]
  onSave: (tags: string[]) => void
  saving?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>(current)
  const [draft, setDraft] = useState("")

  useEffect(() => {
    if (!open) setSelected(current)
  }, [current, open])

  const toggle = (tag: string) => {
    setSelected((previous) => {
      if (previous.includes(tag)) return previous.filter((candidate) => candidate !== tag)
      if (previous.length >= MAX_FORUM_TAGS_PER_POST || tag.length > MAX_FORUM_TAG_LENGTH) {
        return previous
      }
      return [...previous, tag]
    })
  }

  const addDraft = () => {
    const tag = draft.trim().toLowerCase()
    if (!tag || tag.length > MAX_FORUM_TAG_LENGTH) return
    setSelected((previous) => {
      if (previous.length >= MAX_FORUM_TAGS_PER_POST || previous.includes(tag)) return previous
      return [...previous, tag]
    })
    setDraft("")
  }

  const close = () => {
    setOpen(false)
    const changed = selected.length !== current.length
      || selected.some((tag, index) => tag !== current[index])
    if (changed) onSave(selected)
  }

  const chips = [...new Set([...allTags, ...selected])].sort()

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setSelected(current)
          setDraft("")
          setOpen(true)
          return
        }
        close()
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent
        side="bottom"
        align="end"
        className="w-64 space-y-3 p-3"
        data-testid={tid.forumTagDialog}
        aria-label={`Edit tags for ${postName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-[11px] font-medium tracking-[0.12em] text-muted-foreground">TAGS</p>

        <div className="flex flex-wrap items-center gap-1.5">
          {chips.length === 0 ? (
            <p className="text-xs text-muted-foreground">No tags yet</p>
          ) : chips.map((tag) => {
            const active = selected.includes(tag)
            const additionBlocked = !active && (
              selected.length >= MAX_FORUM_TAGS_PER_POST
              || tag.length > MAX_FORUM_TAG_LENGTH
            )
            return (
              <button
                key={tag}
                type="button"
                data-testid={tid.forumTagDialogChip(tag)}
                disabled={saving || additionBlocked}
                aria-label={`${active ? "Remove" : "Add"} tag ${tag}`}
                title={`#${tag}`}
                style={tagColorStyle(tag)}
                className={cn(
                  "inline-flex max-w-full min-w-0 items-center rounded-lg px-2 py-1 text-xs transition-opacity disabled:cursor-not-allowed disabled:opacity-40",
                  tagColorClassName,
                  active ? "opacity-100 ring-1 ring-current/20" : "opacity-55 hover:opacity-80",
                )}
                onClick={() => toggle(tag)}
              >
                <span className="min-w-0 truncate">#{tag}</span>
                {active && <X aria-hidden="true" className="ml-1 size-3 shrink-0" />}
              </button>
            )
          })}
        </div>

        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value.slice(0, MAX_FORUM_TAG_LENGTH))}
          onKeyDown={onEnterSubmit(addDraft)}
          maxLength={MAX_FORUM_TAG_LENGTH}
          placeholder="Add a tag…"
          className="h-8 text-sm"
          disabled={saving || selected.length >= MAX_FORUM_TAGS_PER_POST}
        />

        <p className="text-right text-[11px] text-muted-foreground">
          {saving ? "Saving…" : "↵ to add · saves on close"}
        </p>
      </PopoverContent>
    </Popover>
  )
}
