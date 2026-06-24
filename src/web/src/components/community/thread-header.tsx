"use client"

import { useState } from "react"
import { Hash, MessagesSquare, ChevronRight, ChevronLeft, X, Pencil, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Thread } from "./_types"

// Thread header — breadcrumb (# channel › thread) + rename + close.
export function ThreadHeader({ thread, channelName = "welcome", forum, onClose, onBack, onRename }: {
  thread: Thread
  channelName?: string
  forum?: boolean
  onClose: () => void
  onBack?: () => void
  onRename?: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(thread.name)
  const save = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== thread.name) onRename?.(trimmed)
    setEditing(false)
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-3">
      {onBack && (
        <Button variant="ghost" size="icon-sm" onClick={onBack} className="text-muted-foreground hover:text-foreground" aria-label="Back"><ChevronLeft className="size-5" /></Button>
      )}
      {/* breadcrumb: # channel › thread — clicking the channel returns to it */}
      <Button variant="ghost" size="sm" onClick={onClose} className="-mr-1 gap-1.5 px-1.5 text-base font-medium text-muted-foreground hover:text-foreground">
        {forum ? <MessagesSquare className="size-5" /> : <Hash className="size-5" />}
        {channelName}
      </Button>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      <MessagesSquare className="size-5 shrink-0 text-muted-foreground" />
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false) }}
            className="h-7 text-base font-medium"
            autoFocus
          />
          <Button variant="ghost" size="icon-sm" onClick={save} aria-label="Save"><Check className="size-4" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setEditing(false)} aria-label="Cancel"><X className="size-4" /></Button>
        </div>
      ) : (
        <button onClick={() => { if (onRename) { setDraft(thread.name); setEditing(true) } }} className="min-w-0 truncate text-base font-medium hover:underline">
          {thread.name}
        </button>
      )}
      {!editing && onRename && (
        <Button variant="ghost" size="icon-sm" onClick={() => { setDraft(thread.name); setEditing(true) }} className="text-muted-foreground hover:text-foreground" aria-label="Rename thread"><Pencil className="size-4" /></Button>
      )}
      <Button variant="ghost" size="icon-sm" onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="Close thread"><X className="size-5" /></Button>
    </header>
  )
}
