"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { onEnterSubmit } from "@/lib/ime"
import { CreateDialogShell } from "./create-dialog-shell"
import { PrivateCategoryRow } from "../members/private-category-row"

// Create Category dialog — name + private toggle (defaults to public). In a
// private category any member can create a channel, but each channel is visible
// only to its creator + invited members — admins get no visibility bypass. A
// public category's channels are visible to everyone.
export function CreateCategoryDialog({ onClose, onCreate, canTogglePrivate = true }: {
  onClose: () => void
  onCreate: (name: string, opts: { private: boolean }) => void
  canTogglePrivate?: boolean
}) {
  const [name, setName] = useState("")
  const [isPrivate, setIsPrivate] = useState(false)
  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed.toUpperCase(), { private: isPrivate })
    onClose()
  }
  return (
    <CreateDialogShell
      onClose={onClose}
      title="New category"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>Create category</Button>
        </>
      }
    >
      <div className="space-y-6 px-5 pb-5 pt-2">
        {/* Category name = hero: large inline title input. */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onEnterSubmit(submit)}
          placeholder="e.g. Text channels"
          autoFocus
          aria-label="Category name"
          className="w-full border-0 bg-transparent p-0 text-[30px] font-medium leading-tight tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
        />
        {canTogglePrivate && (
          <PrivateCategoryRow isPrivate={isPrivate} onToggle={setIsPrivate} />
        )}
      </div>
    </CreateDialogShell>
  )
}
