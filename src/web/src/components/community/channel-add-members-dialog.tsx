"use client"

import { toast } from "sonner"
import { AddMembersDialog } from "./add-members-dialog"
import {
  useAddableMembers,
  useAddChannelMember,
} from "@/hooks/community/use-channel-members"

/**
 * Channel/post add-members dialog: a thin wrapper that resolves the addable
 * server members (not-yet-in-channel) and wires the add mutation, then renders
 * the shared `AddMembersDialog`. Add-only — the current roster and its
 * remove/leave controls live in the Members drawer's row right-click menu.
 */
export function ChannelAddMembersDialog({
  channelId,
  channelName,
  onClose,
}: {
  channelId: string
  channelName: string
  onClose: () => void
}) {
  const { members: addable } = useAddableMembers(channelId)
  const addMember = useAddChannelMember(channelId)

  const candidates = addable.map((m) => ({
    userId: m.userId,
    name: m.name ?? null,
    avatar: m.avatar,
  }))

  return (
    <AddMembersDialog
      title={`Add members to /${channelName}`}
      subtitle="Added members can see and post in this channel."
      candidates={candidates}
      addPending={addMember.isPending}
      onAdd={async (userId) => {
        try {
          await addMember.mutateAsync(userId)
        } catch (err) {
          toast(err instanceof Error ? err.message : "Couldn't add member")
        }
      }}
      onClose={onClose}
    />
  )
}
