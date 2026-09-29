"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import type { CommunityRole } from "@alook/shared"
import { dispatchMemberOverlayEvent } from "@/hooks/community/use-server-members"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import {
  serverMembershipSchema,
  type ServerMembershipRow,
} from "@/lib/community-db/schema"

/**
 * Member-scoped mutations write through the canonical membership collection.
 * The descriptor keeps those exact writes over cached cursor pages until the
 * next explicit authoritative reconciliation.
 */

// ── Set member role ────────────────────────────────────────────────────────

export type SetMemberRoleArgs = {
  serverId: string
  memberId: string
  role: CommunityRole
}

export function useSetMemberRole() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, SetMemberRoleArgs, { snapshot: ServerMembershipRow | undefined }>({
    mutationFn: async ({ serverId, memberId, role }) => {
      await apiFetch(`/api/community/servers/${serverId}/members/${memberId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      })
    },
    onMutate: async (args) => {
      const registry = getCommunityDbRegistry(queryClient)
      const current = registry && [...registry.collections.serverMemberships.values()].find(
        (membership) => membership.serverId === args.serverId
          && membership.memberId === args.memberId,
      )
      const snapshot = current ? serverMembershipSchema.parse(current) : undefined
      if (snapshot && registry) {
        registry.markServerMembershipChanged(args.serverId, snapshot.id)
        registry.collections.serverMemberships.utils.writeUpdate({
          id: snapshot.id,
          role: args.role,
        })
      }
      // Mirror the role change onto any active search overlay so a member
      // shown in the search results reflects the new role while the request
      // is in flight (and after — the server won't fan out a MEMBER_UPDATE
      // to the acting client, so this is the only source of truth for the
      // overlay).
      dispatchMemberOverlayEvent({
        type: "role",
        serverId: args.serverId,
        memberId: args.memberId,
        role: args.role,
      })
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry) {
        registry.markServerMembershipChanged(args.serverId, ctx.snapshot.id)
        registry.collections.serverMemberships.utils.writeUpdate(ctx.snapshot)
      }
      dispatchMemberOverlayEvent({ type: "refresh", serverId: args.serverId })
    },
  })
}

// ── Kick member ────────────────────────────────────────────────────────────

export type KickMemberArgs = { serverId: string; memberId: string }

export function useKickMember() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, KickMemberArgs, { snapshot: ServerMembershipRow | undefined }>({
    mutationFn: async ({ serverId, memberId }) => {
      await apiFetch(`/api/community/servers/${serverId}/members/${memberId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const registry = getCommunityDbRegistry(queryClient)
      const current = registry && [...registry.collections.serverMemberships.values()].find(
        (membership) => membership.serverId === args.serverId
          && membership.memberId === args.memberId,
      )
      const snapshot = current ? serverMembershipSchema.parse(current) : undefined
      if (snapshot && registry) {
        registry.markServerMembershipChanged(args.serverId, snapshot.id, true)
        registry.adjustServerMembersTotal(args.serverId, -1)
        registry.collections.serverMemberships.utils.writeDelete(snapshot.id)
      }
      // Mirror the removal onto any active search overlay.
      dispatchMemberOverlayEvent({
        type: "kick",
        serverId: args.serverId,
        memberId: args.memberId,
      })
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry) {
        registry.markServerMembershipChanged(args.serverId, ctx.snapshot.id)
        registry.adjustServerMembersTotal(args.serverId, 1)
        registry.collections.serverMemberships.utils.writeInsert(ctx.snapshot)
      }
      dispatchMemberOverlayEvent({ type: "refresh", serverId: args.serverId })
    },
  })
}
