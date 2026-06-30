"use client"

import { useState } from "react"
import { ListChevronsUpDown, ChevronRight, ChevronLeft, X, Pencil } from "lucide-react"
import { ChannelIcon } from "./channel-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import type { Thread } from "./_types"

export function ThreadHeader({ thread, channelName = "welcome", forum, onClose, onBack, onRename }: {
  thread: Thread
  channelName?: string
  forum?: boolean
  onClose: () => void
  onBack?: () => void
  onRename?: (name: string) => void
}) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [draft, setDraft] = useState(thread.name)

  const save = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== thread.name) onRename?.(trimmed)
    setRenameOpen(false)
  }

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border/40 px-3">
        {onBack && (
          <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose} className="-mr-1 gap-1.5 px-1.5 text-base font-medium text-muted-foreground hover:text-foreground">
          {forum ? <ListChevronsUpDown className="size-5" /> : <ChannelIcon className="h-5 text-muted-foreground" />}
          {channelName}
        </Button>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        <ChannelIcon className="shrink-0 text-base text-muted-foreground" />
        <span className="min-w-0 truncate text-base font-medium">{thread.name}</span>
        {onRename && (
          <Button variant="ghost" size="icon-sm" onClick={() => { setDraft(thread.name); setRenameOpen(true) }} className="text-muted-foreground hover:text-foreground" aria-label="Rename"><Pencil className="size-4" /></Button>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-5" /></Button>
      </header>

      {renameOpen && (
        <Dialog open onOpenChange={(o) => { if (!o) setRenameOpen(false) }}>
          <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
            <DialogHeader className="border-b border-border px-5 py-4">
              <DialogTitle>Rename Channel</DialogTitle>
            </DialogHeader>
            <div className="px-5 pb-5 pt-4">
              <label className="block">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel Name</div>
                <div className="relative">
                  <ChannelIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" />
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") save() }}
                    placeholder="channel-name"
                    className="h-10 pl-9"
                    autoFocus
                  />
                </div>
              </label>
            </div>
            <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-5 py-3">
              <Button variant="ghost" size="sm" onClick={() => setRenameOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={save} disabled={!draft.trim()}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
