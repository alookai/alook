"use client"

import { AddMembersDialog } from "./add-members-dialog"
import {
  useAddableMembers,
  useAddChannelMember,
} from "@/hooks/community/use-channel-members"

export function ChannelAddMembersDialog({
  serverId,
  channelId,
  channelName,
  onClose,
}: {
  serverId: string
  channelId: string
  channelName: string
  onClose: () => void
}) {
  const addableQuery = useAddableMembers(serverId, channelId)
  const { members: addable } = addableQuery
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
      queryState={{
        resolved: addableQuery.data !== undefined,
        loading: addableQuery.isLoading,
        error: addableQuery.isError,
        retrying: addableQuery.data === undefined && addableQuery.isFetching,
        retry: () => { void addableQuery.refetch() },
      }}
      onAdd={(userId) => addMember.mutateAsync(userId)}
      onClose={onClose}
    />
  )
}
