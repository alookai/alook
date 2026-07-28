"use client"

import { useState } from "react"
import { Check } from "lucide-react"
import { EntityIcon } from "./entity-icon"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { onEnterSubmit } from "@/lib/ime"
import { SlugHint } from "./slug-hint"
import { previewSlug } from "@/lib/community/slug-preview"
import type { ChannelType } from "@alook/shared"

// Create / edit Channel dialog. v0.1 supports Text + Forum only. No private toggle.
// Submits { name, type }.
// Pass `initial` to edit an existing channel (prefills + relabels to "Edit Channel").
export function CreateChannelDialog({ category, initial, onClose, onCreate }: {
  category: string
  initial?: { name: string; type: ChannelType }
  onClose: () => void
  onCreate: (channel: { name: string; type: ChannelType }) => void
}) {
  const editing = !!initial
  const [type, setType] = useState<ChannelType>(initial?.type ?? "text")
  const [name, setName] = useState(initial?.name ?? "")

  const options: { value: ChannelType; label: string; desc: string }[] = [
    { value: "text", label: "Text", desc: "Send messages, images, emoji, and opinions" },
    { value: "forum", label: "Forum", desc: "Create a space for organized discussions" },
  ]

  const namePreview = previewSlug(name)
  const submit = () => {
    const trimmed = name.trim()
    if (!namePreview.slug) return
    onCreate({ name: trimmed, type })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        {/* Small breadcrumb for context; the name below is the hero. */}
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-xs font-normal text-muted-foreground">
            {editing ? "Edit channel" : "New channel"}{category ? ` in ${category}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-6 px-5 pb-5 pt-2">
          {/* Channel name = hero: large inline title input, glyph in front. */}
          <div>
            <div className="flex items-center gap-2">
              <EntityIcon kind={type} className="size-6 shrink-0 text-muted-foreground" />
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onEnterSubmit(submit)}
                placeholder="new-channel"
                autoFocus
                aria-label="Channel name"
                className="w-full border-0 bg-transparent p-0 text-[30px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
              />
            </div>
            <div className="mt-1 pl-8">
              <SlugHint {...namePreview} />
            </div>
          </div>
          {/* Channel type = secondary: quiet vertical list, selected row tinted + check. */}
          {!editing && (
            <div>
              <div className="mb-1 text-xs text-muted-foreground">Type</div>
              <div className="space-y-1">
                {options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setType(o.value)}
                    aria-pressed={type === o.value}
                    className={[
                      "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                      type === o.value ? "bg-accent" : "hover:bg-accent/40",
                    ].join(" ")}
                  >
                    <EntityIcon kind={o.value} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{o.label}</span>
                      <span className="block text-xs text-muted-foreground">{o.desc}</span>
                    </span>
                    {type === o.value && <Check className="size-4 shrink-0 text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 px-5 pb-5">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" data-testid={tid.createChannelSubmit} onClick={submit} disabled={!namePreview.slug}>{editing ? "Save" : "Create Channel"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
