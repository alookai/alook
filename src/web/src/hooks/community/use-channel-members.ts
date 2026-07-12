"use client"

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"

export type ChannelMember = {
  userId: string
  name: string | null
  discriminator: string | null
  avatar: string
  addedAt: string
  isCreator: boolean
}

export type AddableMember = {
  userId: string
  name: string | null
  discriminator: string | null
  avatar: string
}

const EMPTY_MEMBERS: readonly ChannelMember[] = Object.freeze([])
const EMPTY_ADDABLE: readonly AddableMember[] = Object.freeze([])

/** Current roster of a private-category channel. */
export function useChannelMembers(
  channelId: string,
  enabled = true,
): UseQueryResult<{ members: ChannelMember[] }> & { members: ChannelMember[] } {
  const query = useQuery({
    queryKey: communityKeys.channelMembers(channelId),
    queryFn: () =>
      apiFetch<{ members: ChannelMember[] }>(
        `/api/community/channels/${encodeURIComponent(channelId)}/members`,
      ),
    enabled: enabled && !!channelId,
  })
  return { ...query, members: query.data?.members ?? (EMPTY_MEMBERS as ChannelMember[]) }
}

/** Server members not yet in the channel — the add picker. */
export function useAddableMembers(
  channelId: string,
  enabled = true,
): UseQueryResult<{ members: AddableMember[] }> & { members: AddableMember[] } {
  const query = useQuery({
    queryKey: communityKeys.channelAddableMembers(channelId),
    queryFn: () =>
      apiFetch<{ members: AddableMember[] }>(
        `/api/community/channels/${encodeURIComponent(channelId)}/addable-members`,
      ),
    enabled: enabled && !!channelId,
  })
  return { ...query, members: query.data?.members ?? (EMPTY_ADDABLE as AddableMember[]) }
}

export function useAddChannelMember(channelId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/api/community/channels/${encodeURIComponent(channelId)}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: communityKeys.channelMembers(channelId) })
      void qc.invalidateQueries({ queryKey: communityKeys.channelAddableMembers(channelId) })
    },
  })
}

export function useRemoveChannelMember(channelId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(
        `/api/community/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: communityKeys.channelMembers(channelId) })
      void qc.invalidateQueries({ queryKey: communityKeys.channelAddableMembers(channelId) })
    },
  })
}
