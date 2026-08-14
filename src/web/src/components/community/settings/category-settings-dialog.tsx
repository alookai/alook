"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { onEnterSubmit } from "@/lib/ime"
import { CreateDialogShell } from "./create-dialog-shell"
import { PrivateCategoryRow } from "../members/private-category-row"

// Category settings dialog — rename only. Privacy (public/private) is fixed at
// creation and can't be changed here: flipping it would silently widen/tighten
// channel visibility. To change privacy, delete the category and recreate it.
// The current privacy is shown read-only for context.
export function CategorySettingsDialog({ name, isPrivate, onClose, onSave }: {
  name: string
  isPrivate: boolean
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [nameDraft, setNameDraft] = useState(name)
  const trimmedName = nameDraft.trim()
  const save = () => {
    if (!trimmedName) return
    onSave(trimmedName.toUpperCase())
    onClose()
  }
  return (
    <CreateDialogShell
      onClose={onClose}
      title="Category settings"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!trimmedName}>Save</Button>
        </>
      }
    >
      <div className="space-y-6 px-5 pb-5 pt-2">
        {/* Category name = hero: large inline title input. */}
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={onEnterSubmit(save)}
          placeholder="e.g. Text channels"
          autoFocus
          aria-label="Category name"
          className="w-full border-0 bg-transparent p-0 text-[30px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
        />
        {isPrivate && <PrivateCategoryRow isPrivate locked />}
      </div>
    </CreateDialogShell>
  )
}
