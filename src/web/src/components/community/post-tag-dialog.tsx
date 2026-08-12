"use client"

import { useEffect, useState, type ReactElement } from "react"
import { X } from "lucide-react"
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
    setSelected((previous) => previous.includes(tag)
      ? previous.filter((candidate) => candidate !== tag)
      : [...previous, tag])
  }

  const addDraft = () => {
    const tag = draft.trim().toLowerCase()
    setDraft("")
    if (!tag || selected.includes(tag)) return
    setSelected((previous) => [...previous, tag])
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
            return (
              <button
                key={tag}
                type="button"
                style={tagColorStyle(tag)}
                className={cn(
                  "inline-flex items-center rounded-lg px-2 py-1 text-xs transition-opacity",
                  tagColorClassName,
                  active ? "opacity-100 ring-1 ring-current/20" : "opacity-55 hover:opacity-80",
                )}
                onClick={() => toggle(tag)}
              >
                #{tag}
                {active && <X className="ml-1 size-3" />}
              </button>
            )
          })}
        </div>

        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onEnterSubmit(addDraft)}
          placeholder="Add a tag…"
          className="h-8 text-sm"
          disabled={saving}
        />

        <p className="text-[11px] text-muted-foreground">
          {saving ? "Saving…" : "↵ to add · saves on close"}
        </p>
      </PopoverContent>
    </Popover>
  )
}
