"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Avatar } from "./avatar"
import {
  useThreadParticipants,
  useAddThreadParticipant,
} from "@/hooks/community/use-thread-participants"
import { useChannelMembers } from "@/hooks/community/use-channel-members"

/**
 * Add participants to a thread — a pure picker of parent-channel members not
 * yet participating. Any participant may add. The current participant list and
 * its leave/remove controls live in the Members drawer's row right-click menu
 * (see `MemberList` `threadContext`), not here. Read access to the thread is
 * unaffected — participation is purely the notification set; muting is the
 * outer channel-header notification level.
 */
export function ThreadParticipantsDialog({
  channelId,
  parentChannelId,
  threadName,
  viewerUserId,
  onClose,
}: {
  channelId: string
  parentChannelId: string | null
  threadName: string
  viewerUserId: string
  onClose: () => void
}) {
  // Existing participants — only to exclude them from the add list.
  const { participants } = useThreadParticipants(channelId)
  // Candidate pool = the parent channel's audience.
  const { members: parentMembers } = useChannelMembers(parentChannelId ?? "", !!parentChannelId)
  const addParticipant = useAddThreadParticipant(channelId)
  const [query, setQuery] = useState("")

  const participantIds = useMemo(() => new Set(participants.map((p) => p.userId)), [participants])
  const addable = useMemo(() => {
    const q = query.trim().toLowerCase()
    return parentMembers
      .filter((m) => !participantIds.has(m.userId) && m.userId !== viewerUserId)
      .filter((m) => (q ? (m.name ?? "").toLowerCase().includes(q) : true))
  }, [parentMembers, participantIds, viewerUserId, query])

  const onAdd = async (userId: string) => {
    try {
      await addParticipant.mutateAsync(userId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't add participant")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold">Add participants to /{threadName}</h2>
          <p className="text-xs text-muted-foreground">
            Added people are notified of new replies. Anyone with access can already read the thread.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-2 py-2">
          <label className="relative mx-2 mb-2 block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              className="pl-9"
            />
          </label>
          {addable.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {query ? "No matches." : "Everyone is already here."}
            </p>
          ) : (
            addable.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
                <Avatar label={m.avatar || m.name || ""} seed={m.userId} size={32} />
                <div className="min-w-0 flex-1 truncate text-sm font-medium">{m.name ?? "Unknown"}</div>
                <Button size="sm" disabled={addParticipant.isPending} onClick={() => onAdd(m.userId)}>
                  Add
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
