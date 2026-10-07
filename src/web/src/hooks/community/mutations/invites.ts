"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useMutation, useQueryClient, QueryObserver, type Query } from "@tanstack/react-query"
import { useCommunityMutationOrigin } from "../community-origin"
import { communityKeys } from "@/lib/query-keys"
import { invitesQueryFn, type InvitesResponse } from "../use-server-panels"

export type ResolveInviteResult = { token: string; uses: number; maxUses: number | null; expiresAt: string | null }
type OriginalView = (() => void) & { signal: AbortSignal }
type ResolveInviteArgs = { currentUserId: string; assert: OriginalView }

export function useResolveOrCreateInvite(serverId: string) {
  const client = useQueryClient(), origin = useCommunityMutationOrigin()
  type Intent = ResolveInviteArgs & { original: ReturnType<typeof origin.begin>["token"] }
  const native = useMutation({ meta: { observabilityAction: "server.invite.resolve" },
    mutationKey: ["community", "invite-resolve", serverId],
    scope: { id: "community-invite-command" },
    gcTime: 0,
    mutationFn: async ({ currentUserId, assert, original }: Intent): Promise<ResolveInviteResult> => {
      origin.assert(original); assert()
      const options = { queryKey: communityKeys.invites(serverId), queryFn: invitesQueryFn(serverId), staleTime: 60_000 }
      const observer = new QueryObserver(client, { ...options, enabled: false })
      const unsubscribe = observer.subscribe(() => undefined)
      assert.signal.addEventListener("abort", unsubscribe, { once: true })
      let cached: InvitesResponse
      try { cached = await client.query({ ...options, select: undefined }); origin.assert(original); assert() }
      finally { assert.signal.removeEventListener("abort", unsubscribe); unsubscribe() }
      const now = new Date().toISOString()
      const reusable = cached.invites.find((invite) => invite.creatorId === currentUserId && (!invite.expiresAt || invite.expiresAt > now) && (invite.maxUses === null || invite.uses < invite.maxUses))
      if (reusable) return { token: reusable.code, uses: reusable.uses, maxUses: reusable.maxUses, expiresAt: reusable.expiresAt }
      const resource = client.getQueryCache().find({ queryKey: options.queryKey, exact: true })
      await client.cancelQueries({ queryKey: options.queryKey, exact: true })
      origin.assert(original); assert()
      const result = await origin.request<{ invite: ResolveInviteResult }>(original, "/api/community/servers/" + serverId + "/invites", { method: "POST", signal: assert.signal, assertActive: assert })
      origin.assert(original); assert()
      if (resource && client.getQueryCache().find({ queryKey: options.queryKey, exact: true }) === resource) {
        await client.cancelQueries({ queryKey: options.queryKey, exact: true })
        origin.assert(original); assert()
        if (client.getQueryCache().find({ queryKey: options.queryKey, exact: true }) === resource) client.setQueryData<InvitesResponse>(options.queryKey, (current) => current && !current.invites.some((row) => row.code === result.invite.token) ? { invites: [{ code: result.invite.token, uses: result.invite.uses, maxUses: result.invite.maxUses, expiresAt: result.invite.expiresAt, creatorId: currentUserId }, ...current.invites.filter((row) => row.code !== result.invite.token)] } : current)
      }
      return result.invite
    },
  })
  const capture = useCallback((input: ResolveInviteArgs): Intent => { input.assert(); return { ...input, original: origin.begin().token } }, [origin])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assert() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export type RevokeInviteArgs = { serverId: string; code: string; assertActive?: OriginalView }

export function useRevokeInvite() {
  const client = useQueryClient(), origin = useCommunityMutationOrigin()
  type Intent = RevokeInviteArgs & { original: ReturnType<typeof origin.begin>["token"]; resource: Query | undefined }
  const native = useMutation({ meta: { observabilityAction: "server.invite.revoke" },
    mutationKey: ["community", "invite-revoke"],
    scope: { id: "community-invite-command" }, gcTime: 0,
    mutationFn: async ({ serverId, code, original, resource, assertActive }: Intent) => {
      origin.assert(original); assertActive?.()
      const key = communityKeys.invites(serverId)
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) await client.cancelQueries({ queryKey: key, exact: true })
      origin.assert(original); assertActive?.()
      const writes = resource?.state.dataUpdateCount
      await origin.request(original, "/api/community/invites/" + code, { method: "DELETE", signal: assertActive?.signal, assertActive })
      origin.assert(original); assertActive?.()
      if (resource && client.getQueryCache().find({ queryKey: key, exact: true }) === resource) {
        await client.cancelQueries({ queryKey: key, exact: true })
        origin.assert(original); assertActive?.()
        if (client.getQueryCache().find({ queryKey: key, exact: true }) === resource && resource.state.dataUpdateCount === writes) client.setQueryData<InvitesResponse>(key, (current) => current ? { invites: current.invites.filter((row) => row.code !== code) } : current)
      }
    },
  })
  const capture = useCallback((input: RevokeInviteArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resource: client.getQueryCache().find({ queryKey: communityKeys.invites(input.serverId), exact: true }) } }, [origin, client])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
