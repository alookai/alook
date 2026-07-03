"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Field } from "./field"

// Create Category dialog — name + private toggle (default public). A private category
// restricts channel creation to admins.
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
              onKeyDown={(e) => { if (e.key === "Enter") submit() }}
              placeholder="e.g. text channels"
              autoFocus
            />
          </Field>
          {canTogglePrivate && (
            <label className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
              <Lock className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Private category</div>
                <div className="text-xs text-muted-foreground">Only admins can create channels here.</div>
              </div>
              <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
            </label>
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
