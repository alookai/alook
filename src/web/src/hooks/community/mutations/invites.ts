"use client"

import { useCallback } from "react"
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

type CreateInviteArgs = {
  serverId: string
  creatorId: string
  creatorName: string
}

type CreateInviteResult = {
  invite: {
    token: string
    uses: number
    maxUses: number | null
    expiresAt: string | null
  }
}

function useCreateInvite() {
  const queryClient = useQueryClient()
  return useMutation<CreateInviteResult, Error, CreateInviteArgs>({
    mutationFn: async ({ serverId }) => {
      return apiFetch<CreateInviteResult>(
        `/api/community/servers/${serverId}/invites`,
        { method: "POST" },
      )
    },
    onSuccess: (data, args) => {
      const fresh = {
        code: data.invite.token,
        uses: data.invite.uses,
        maxUses: data.invite.maxUses,
        expiresAt: data.invite.expiresAt,
        by: args.creatorName,
        creatorId: args.creatorId,
      }
      queryClient.setQueryData<InvitesResponse | undefined>(
        communityKeys.invites(args.serverId),
        (prev) =>
          prev
            ? { ...prev, invites: [fresh, ...prev.invites] }
            : { invites: [fresh] },
      )
    },
  })
}

// ── Resolve-or-create current invite ─────────────────────────────────────
//
// The share popover wants "a link the user can hand to a friend right now".
// Creating one on every open would burn the 50-active-per-server cap in
// short order (`route.ts:76-81`), so we reuse an existing valid invite
// created by this user first and only mint a fresh one if the pool has
// nothing usable.

export type ResolveInviteResult = {
  token: string
  uses: number
  maxUses: number | null
  expiresAt: string | null
}

/**
 * Returns a `resolve(currentUserId, currentUserName) → invite` handle.
 *
 * A hook (not a static function) so it reads the cached invite list and pipes
 * the "we just created one" write into that same cache — the dialog can then
 * close/reopen without re-fetching or re-minting. Only invites the current
 * user created themselves are candidates for reuse; if none is still usable
 * (unexpired, uses < maxUses), POST a new one via `useCreateInvite`.
 */
export function useResolveOrCreateInvite(serverId: string) {
  const queryClient = useQueryClient()
  const createMut = useCreateInvite()

  return useCallback(
    async (currentUserId: string, currentUserName: string): Promise<ResolveInviteResult> => {
      const cache = queryClient.getQueryData<InvitesResponse>(
        communityKeys.invites(serverId),
      )
      const nowIso = new Date().toISOString()
      const reusable = cache?.invites.find((iv) => {
        if (iv.creatorId !== currentUserId) return false
        if (iv.expiresAt && iv.expiresAt <= nowIso) return false
        if (iv.maxUses !== null && iv.uses >= iv.maxUses) return false
        return true
      })
      if (reusable) {
        return {
          token: reusable.code,
          uses: reusable.uses,
          maxUses: reusable.maxUses,
          expiresAt: reusable.expiresAt,
        }
      }
      const { invite } = await createMut.mutateAsync({
        serverId,
        creatorId: currentUserId,
        creatorName: currentUserName,
      })
      return invite
    },
    [serverId, queryClient, createMut],
  )
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
