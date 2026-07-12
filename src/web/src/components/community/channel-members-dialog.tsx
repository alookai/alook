"use client"

import { useMemo, useState } from "react"
import { Search, X } from "lucide-react"
import { toast } from "sonner"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar } from "./avatar"
import {
  useChannelMembers,
  useAddableMembers,
  useAddChannelMember,
  useRemoveChannelMember,
} from "@/hooks/community/use-channel-members"

/**
 * Manage the roster of a private-category channel: current members (creator
 * locked, everyone else removable) plus a picker of server members not yet in
 * the channel. Adding grants read/post access immediately; removing evicts.
 */
export function ChannelMembersDialog({
  channelId,
  channelName,
  serverId: _serverId,
  onClose,
}: {
  channelId: string
  channelName: string
  serverId: string
  onClose: () => void
}) {
  const { members, isLoading: membersLoading } = useChannelMembers(channelId)
  const { members: addable, isLoading: addableLoading } = useAddableMembers(channelId)
  const addMember = useAddChannelMember(channelId)
  const removeMember = useRemoveChannelMember(channelId)
  const [query, setQuery] = useState("")

  const filteredAddable = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return addable
    return addable.filter((m) => (m.name ?? "").toLowerCase().includes(q))
  }, [addable, query])

  const onAdd = async (userId: string) => {
    try {
      await addMember.mutateAsync(userId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't add member")
    }
  }

  const onRemove = async (userId: string) => {
    try {
      await removeMember.mutateAsync(userId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't remove member")
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="flex max-h-[80vh] w-full flex-col gap-0 p-0 sm:max-w-md">
        <header className="border-b border-border px-4 py-3">
          <h2 className="truncate text-sm font-semibold">Members of /{channelName}</h2>
          <p className="text-xs text-muted-foreground">
            Only these members and admins can see and post in this channel.
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar px-2 py-2">
          {membersLoading && members.length === 0 ? (
            <div className="space-y-2 px-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-3 w-32 rounded" />
                </div>
              ))}
            </div>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
                <Avatar label={m.avatar || m.name || ""} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {m.name ?? "Unknown"}
                    {m.isCreator && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">Creator</span>
                    )}
                  </div>
                </div>
                {!m.isCreator && (
                  <button
                    onClick={() => onRemove(m.userId)}
                    disabled={removeMember.isPending}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed"
                    aria-label={`Remove ${m.name ?? "member"}`}
                    title="Remove member"
                  >
                    <X className="size-4" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Add members</div>
          <label className="relative block">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members"
              className="pl-9"
            />
          </label>
          <div className="mt-2 max-h-48 overflow-y-auto thin-scrollbar">
            {addableLoading && addable.length === 0 ? (
              <div className="space-y-2 py-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-full" />
                    <Skeleton className="h-3 w-28 rounded" />
                  </div>
                ))}
              </div>
            ) : filteredAddable.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {addable.length === 0
                  ? "Everyone in the server is already here."
                  : "No matches."}
              </p>
            ) : (
              filteredAddable.map((m) => (
                <div key={m.userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/40">
                  <Avatar label={m.avatar || m.name || ""} size={32} />
                  <div className="min-w-0 flex-1 truncate text-sm font-medium">{m.name ?? "Unknown"}</div>
                  <Button size="sm" disabled={addMember.isPending} onClick={() => onAdd(m.userId)}>
                    Add
                  </Button>
                </div>
              ))
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
