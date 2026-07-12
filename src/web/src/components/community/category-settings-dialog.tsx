"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "./field"

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle>Category Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-4 pb-5">
          <Field label="Category name">
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save() }}
              placeholder="e.g. text channels"
              autoFocus
            />
          </Field>
          {isPrivate && (
            <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
              <Lock className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Private category</div>
                <div className="text-xs text-muted-foreground">
                  Members create their own channels here, visible only to invited members. Privacy can&apos;t be changed after creation.
                </div>
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={!trimmedName}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
