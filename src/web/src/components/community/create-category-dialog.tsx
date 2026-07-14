"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { onEnterSubmit } from "@/lib/ime"
import { Field } from "./field"
import { PrivateCategoryRow } from "./private-category-row"

// Create Category dialog — name + private toggle (defaults to public). In a
// private category any member can create a channel, but each channel is visible
// only to its creator + invited members (and admins). A public category's
// channels are admin-managed and visible to everyone.
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle>Create category</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-4 pb-5">
          <Field label="Category name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onEnterSubmit(submit)}
              placeholder="e.g. text channels"
              autoFocus
            />
          </Field>
          {canTogglePrivate && (
            <PrivateCategoryRow isPrivate={isPrivate} onToggle={setIsPrivate} />
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>Create category</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
