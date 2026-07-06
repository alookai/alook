"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityRole } from "@alook/shared"
import {
  dispatchMemberOverlayEvent,
  patchCacheKick,
  patchCacheRole,
  type MembersEnvelope,
} from "@/hooks/community/use-server-members"
import type { InfiniteData } from "@tanstack/react-query"

/**
 * Member-scoped mutations. Both mutations pipe through the
 * `communityKeys.members(serverId)` infinite-cache and reuse the pure patch
 * helpers exported from `use-server-members.ts`. The WS layer patches the
 * same cache on `member.update` / `member.leave`, so success-path
 * invalidation is unnecessary.
 */

type MembersPageCache = InfiniteData<MembersEnvelope>

// ── Set member role ────────────────────────────────────────────────────────

export type SetMemberRoleArgs = {
  serverId: string
  memberId: string
  role: CommunityRole
}

export function useSetMemberRole() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, SetMemberRoleArgs, { snapshot: MembersPageCache | undefined }>({
    mutationFn: async ({ serverId, memberId, role }) => {
      await apiFetch(`/api/community/servers/${serverId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.members(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<MembersPageCache>(key)
      queryClient.setQueryData<MembersPageCache | undefined>(key, (cache) =>
        patchCacheRole(cache, args.memberId, args.role),
      )
      // Mirror the role change onto any active search overlay so a member
      // shown in the search results reflects the new role while the request
      // is in flight (and after — the server won't fan out a MEMBER_UPDATE
      // to the acting client, so this is the only source of truth for the
      // overlay).
      dispatchMemberOverlayEvent({ type: "role", memberId: args.memberId, role: args.role })
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.members(args.serverId), ctx.snapshot)
    },
  })
}

// ── Kick member ────────────────────────────────────────────────────────────

export type KickMemberArgs = { serverId: string; memberId: string }

export function useKickMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, KickMemberArgs, { snapshot: MembersPageCache | undefined }>({
    mutationFn: async ({ serverId, memberId }) => {
      await apiFetch(`/api/community/servers/${serverId}/members/${memberId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.members(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<MembersPageCache>(key)
      queryClient.setQueryData<MembersPageCache | undefined>(key, (cache) =>
        patchCacheKick(cache, args.memberId),
      )
      // Mirror the removal onto any active search overlay.
      dispatchMemberOverlayEvent({ type: "kick", memberId: args.memberId })
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.members(args.serverId), ctx.snapshot)
    },
  })
}
