"use client"

import { useState } from "react"
import { MessagesSquare, Smile } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EmojiPickerPopover } from "./emoji-picker"

// "New Thread" creation dialog — Thread Name + first message to start the thread.
export function NewThreadDialog({ channel, open, onClose, onCreate }: {
  channel: string
  open: boolean
  onClose: () => void
  onCreate: (name: string, firstMessage: string) => void
}) {
  const [name, setName] = useState("")
  const [message, setMessage] = useState("")

  const submit = () => {
    const trimmed = name.trim() || "New Thread"
    onCreate(trimmed, message.trim())
    setName("")
    setMessage("")
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-105 max-w-[calc(100vw-2rem)] p-0">
        <DialogHeader className="border-b border-border px-4 py-4">
          <DialogTitle className="flex items-center gap-2">
            <MessagesSquare className="size-5 text-muted-foreground" />
            New Thread
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 px-4 pb-5">
          <label className="block">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Thread Name</div>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) submit() }}
              placeholder="New Thread"
              autoFocus
            />
          </label>
          <label className="block">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">First Message</div>
            <div className="flex min-h-14 items-center gap-3 rounded-lg bg-secondary px-4 py-3">
              <input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit() }}
                placeholder={`Message /${channel}`}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              <EmojiPickerPopover side="top" align="end" onPick={(e) => setMessage((m) => m + e)}>
                <button className="shrink-0 text-muted-foreground hover:text-foreground aria-expanded:text-foreground" aria-label="Emoji picker">
                  <Smile className="size-5" />
                </button>
              </EmojiPickerPopover>
            </div>
          </label>
        </div>
        <DialogFooter className="mx-0 mb-0 flex-row items-center justify-end gap-2 rounded-b-xl border-t border-border bg-card px-4 py-3">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!name.trim()}>Create Thread</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
