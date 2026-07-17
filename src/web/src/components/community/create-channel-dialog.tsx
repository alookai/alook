"use client"

import { useState } from "react"
import { EntityIcon } from "./entity-icon"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { tid } from "@/lib/community/testids"
import { Input } from "@/components/ui/input"
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
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle>{editing ? "Edit Channel" : "Create Channel"}</DialogTitle>
          <p className="text-sm text-muted-foreground">{category ? `in ${category}` : "top level"}</p>
        </DialogHeader>
        <div className="space-y-4 px-4 pb-5">
          {!editing && (
            <div>
              <div className="mb-2 text-xs font-semibold text-muted-foreground">Channel Type</div>
              <div className="space-y-2">
                {options.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => setType(o.value)}
                    className={[
                      "flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                      type === o.value ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50",
                    ].join(" ")}
                  >
                    <EntityIcon kind={o.value} className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{o.label}</div>
                      <div className="text-xs text-muted-foreground">{o.desc}</div>
                    </div>
                    <span className={`grid size-4 shrink-0 place-items-center rounded-full border ${type === o.value ? "border-primary" : "border-muted-foreground"}`}>
                      {type === o.value && <span className="size-2 rounded-full bg-primary" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="block">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">Channel Name</div>
            <div className="relative">
              <EntityIcon kind={type} className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onEnterSubmit(submit)}
                placeholder="new-channel"
                className="h-10 pl-9"
              />
            </div>
            <SlugHint {...namePreview} />
          </label>
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" data-testid={tid.createChannelSubmit} onClick={submit} disabled={!namePreview.slug}>{editing ? "Save" : "Create Channel"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
