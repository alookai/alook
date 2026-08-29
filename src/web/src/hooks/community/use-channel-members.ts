"use client"

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { apiFetchIdentity } from "@/lib/community/identity-projection"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityRole } from "@alook/shared"
import type { CommunityUserCore } from "@/lib/community/models/people"
import { fetchAllServerMembers } from "./fetch-all-server-members"

// Canonical member shape (superset of the pre-audience roster). `source` tags
// why the user is in the channel: "explicit" (added member or creator),
// "inherited" (public-channel server member), or "admin" (server admin/owner).
// Only `source === "explicit" && !isCreator` rows are removable. Shares the
// identity core (name/discriminator/avatar) with Member/Friend/DM — feeds the
// private-channel/thread mention popup, so the required `discriminator` keeps
// the "mention target always has a tag" guarantee at compile time.
export type ChannelMember = CommunityUserCore & {
  id: string
  userId: string
  sub: string
  role: CommunityRole
  status: "online" | "offline"
  statusEmoji: string | null
  statusText: string
  source: "explicit" | "inherited" | "admin"
  isCreator: boolean
}

export type AddableMember = {
  userId: string
  name: string | null
  discriminator: string | null
  avatar: string
  avatarVersion: number
}

const EMPTY_MEMBERS: readonly ChannelMember[] = Object.freeze([])
const EMPTY_ADDABLE: readonly AddableMember[] = Object.freeze([])

export async function addableMembersQueryFn(serverId: string, channelId: string): Promise<{ members: AddableMember[] }> {
  const [serverMembers, channelData] = await Promise.all([
    fetchAllServerMembers(serverId),
    apiFetchIdentity<{ members: ChannelMember[] }>(`/api/community/channels/${encodeURIComponent(channelId)}/members`),
  ])
  const present = new Set(channelData.members.map((member) => member.userId))
  return {
    members: serverMembers
      .filter((member) => !present.has(member.userId))
      .map((member) => ({
        userId: member.userId,
        name: member.name,
        discriminator: member.discriminator,
        avatar: member.avatar,
        avatarVersion: member.avatarVersion,
      })),
  }
}

/** Current roster of a private-category channel. */
export function useChannelMembers(
  channelId: string,
  enabled = true,
): UseQueryResult<{ members: ChannelMember[] }> & { members: ChannelMember[] } {
  const query = useQuery({
    queryKey: communityKeys.channelMembers(channelId),
    queryFn: () =>
      apiFetchIdentity<{ members: ChannelMember[] }>(
        `/api/community/channels/${encodeURIComponent(channelId)}/members`,
      ),
    enabled: enabled && !!channelId,
  })
  return { ...query, members: query.data?.members ?? (EMPTY_MEMBERS as ChannelMember[]) }
}

/** Server members not yet in the channel — the add picker. */
export function useAddableMembers(
  serverId: string,
  channelId: string,
  enabled = true,
): UseQueryResult<{ members: AddableMember[] }> & { members: AddableMember[] } {
  const query = useQuery({
    queryKey: communityKeys.channelAddableMembers(channelId),
    queryFn: () => addableMembersQueryFn(serverId, channelId),
    enabled: enabled && !!serverId && !!channelId,
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
