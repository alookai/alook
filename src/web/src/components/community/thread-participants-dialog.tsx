"use client"

import { useMemo, useState } from "react"
import { Search, X, BellOff, Bell, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import {
  useThreadParticipants,
  useAddThreadParticipant,
  useRemoveThreadParticipant,
  useSetThreadParticipantMuted,
} from "@/hooks/community/use-thread-participants"
import { useChannelMembers } from "@/hooks/community/use-channel-members"

/**
 * Manage a thread's NOTIFY participants: the current participant list (with the
 * viewer's own mute/leave controls) plus — for the thread creator — a picker of
 * parent-channel members not yet participating. Adding notifies them; muting
 * suppresses the viewer's own pings; leaving drops the row (a later
 * mention/speak re-adds). Read access to the thread is unaffected — this is
 * purely the notification set.
 */
export function ThreadParticipantsDialog({
  channelId,
  parentChannelId,
  threadName,
  viewerUserId,
  isCreator,
  onClose,
}: {
  channelId: string
  parentChannelId: string | null
  threadName: string
  viewerUserId: string
  isCreator: boolean
  onClose: () => void
}) {
  const { participants, isLoading } = useThreadParticipants(channelId)
  // Candidate pool for the creator's picker = the parent channel's audience.
  const { members: parentMembers } = useChannelMembers(parentChannelId ?? "", isCreator && !!parentChannelId)
  const addParticipant = useAddThreadParticipant(channelId)
  const removeParticipant = useRemoveThreadParticipant(channelId)
  const setMuted = useSetThreadParticipantMuted(channelId)
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
  const onLeaveOrRemove = async (userId: string) => {
    try {
      await removeParticipant.mutateAsync(userId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't remove participant")
    }
  }
  const onToggleMute = async (userId: string, muted: boolean) => {
    try {
      await setMuted.mutateAsync({ userId, muted })
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't update notifications")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold">Participants of /{threadName}</h2>
          <p className="text-xs text-muted-foreground">
            These people are notified of new replies. Anyone in the channel can still read the thread.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-2 py-2">
          {isLoading && participants.length === 0 ? (
            <div className="space-y-2 px-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-3 w-32 rounded" />
                </div>
              ))}
            </div>
          ) : (
            participants.map((p) => {
              const isSelf = p.userId === viewerUserId
              return (
                <div key={p.userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
                  <Avatar label={p.avatar || p.name || ""} seed={p.userId} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {p.name ?? "Unknown"}
                      {p.muted && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">Muted</span>
                      )}
                    </div>
                  </div>
                  {isSelf && (
                    <button
                      onClick={() => onToggleMute(p.userId, !p.muted)}
                      disabled={setMuted.isPending}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed"
                      aria-label={p.muted ? "Unmute thread" : "Mute thread"}
                      title={p.muted ? "Unmute thread" : "Mute thread"}
                    >
                      {p.muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
                    </button>
                  )}
                  {(isSelf || isCreator) && (
                    <button
                      onClick={() => onLeaveOrRemove(p.userId)}
                      disabled={removeParticipant.isPending}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed"
                      aria-label={isSelf ? "Leave thread" : `Remove ${p.name ?? "participant"}`}
                      title={isSelf ? "Leave thread" : "Remove participant"}
                    >
                      {isSelf ? <LogOut className="size-4" /> : <X className="size-4" />}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>

        {isCreator && parentChannelId && (
          <footer className="border-t border-border px-4 py-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">Add from channel</div>
            <label className="relative block">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search channel members"
                className="pl-9"
              />
            </label>
            <div className="mt-2 max-h-48 overflow-y-auto thin-scrollbar">
              {addable.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {query ? "No matches." : "Everyone in the channel is already here."}
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
          </footer>
        )}
      </DialogContent>
    </Dialog>
  )
}
