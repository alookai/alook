"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { InvitesResponse } from "@/hooks/community/use-server-panels"

/**
 * Invite CRUD for the settings surface. Create prepends the fresh row into
 * the cache — the server response includes the canonical token and creator
 * so no follow-up fetch is required. Revoke filters by token (the API's
 * unique identifier).
 */

// ── Create invite ─────────────────────────────────────────────────────────

export type CreateInviteArgs = {
  serverId: string
  creatorName: string
}

export type CreateInviteResult = {
  invite: {
    token: string
    uses: number
    maxUses: number | null
    expiresAt: string | null
  }
}

export function useCreateInvite() {
  const queryClient = useQueryClient()
  return useMutation<CreateInviteResult, Error, CreateInviteArgs>({
    mutationFn: async ({ serverId }) => {
      return apiFetch<CreateInviteResult>(
        `/api/community/servers/${serverId}/invites`,
        { method: "POST" },
      )
    },
    onSuccess: (data, args) => {
      queryClient.setQueryData<InvitesResponse | undefined>(
        communityKeys.invites(args.serverId),
        (prev) =>
          prev
            ? {
                ...prev,
                invites: [
                  {
                    code: data.invite.token,
                    uses: data.invite.uses,
                    maxUses: data.invite.maxUses,
                    expiresAt: data.invite.expiresAt,
                    by: args.creatorName,
                  },
                  ...prev.invites,
                ],
              }
            : { invites: [
                {
                  code: data.invite.token,
                  uses: data.invite.uses,
                  maxUses: data.invite.maxUses,
                  expiresAt: data.invite.expiresAt,
                  by: args.creatorName,
                },
              ] },
      )
    },
  })
}

// ── Revoke invite ─────────────────────────────────────────────────────────

export type RevokeInviteArgs = { serverId: string; code: string }

export function useRevokeInvite() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, RevokeInviteArgs, { snapshot: InvitesResponse | undefined }>({
    mutationFn: async ({ code }) => {
      await apiFetch(`/api/community/invites/${code}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      const key = communityKeys.invites(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<InvitesResponse>(key)
      queryClient.setQueryData<InvitesResponse | undefined>(key, (prev) =>
        prev ? { ...prev, invites: prev.invites.filter((i) => i.code !== args.code) } : prev,
      )
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.invites(args.serverId), ctx.snapshot)
    },
  })
}
