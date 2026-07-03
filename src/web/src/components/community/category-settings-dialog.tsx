"use client"

import { useState } from "react"
import { Lock } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

// Category settings dialog — toggle privacy. A private category restricts channel
// creation to admins (default public).
export function CategorySettingsDialog({ name, isPrivate, canTogglePrivate = true, onClose, onSave }: {
  name: string
  isPrivate: boolean
  canTogglePrivate?: boolean
  onClose: () => void
  onSave: (isPrivate: boolean) => void
}) {
  const [priv, setPriv] = useState(isPrivate)
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle>Category Settings</DialogTitle>
          <p className="text-sm text-muted-foreground">{name}</p>
        </DialogHeader>
        <div className="px-4 pb-5">
          {canTogglePrivate && (
          <label className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
            <Lock className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Private Category</div>
              <div className="text-xs text-muted-foreground">Only admins can create channels here.</div>
            </div>
            <Switch checked={priv} onCheckedChange={setPriv} />
          </label>
          )}
          {!canTogglePrivate && (
            <p className="text-sm text-muted-foreground">No settings available to change.</p>
          )}
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          {canTogglePrivate && <Button size="sm" onClick={() => { onSave(priv); onClose() }}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
