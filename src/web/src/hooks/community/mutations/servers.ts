"use client"

import { communityCommandInput, useCommunityCommandMutation, type CommunityCommandArgs } from "../use-community-command-mutation"
import { useCallback } from "react"
import { beginCommunityCommandRevision } from "@/lib/community-db/sync"
import { useCommunityMutationOrigin } from "../community-origin"
import { useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { publishCommunityServerFields, publishCommunityServerMembershipRemoval, type CommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadScopeToken,
} from "@/hooks/community/account-unread-projection"
import {
  evictServerChannelScopes,
  flushOwnerServerDeleteAfterSuccess,
} from "@/hooks/community/community-ws/scope-eviction"
import {
  beginOwnerServerDelete,
  cancelOwnerServerDelete,
  commitOwnerServerDelete,
  type OwnerServerDeleteRouteToken,
} from "@/lib/community/eject-server"

// ── Create server ──────────────────────────────────────────────────────────

export type CreateServerArgs = { name: string }
export type CreateServerResult = { server: { id: string } }

export function useCreateServer() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  return useCommunityCommandMutation<CreateServerResult, Error, CreateServerArgs>(origin, {
    mutationFn: async ({ name, original }) => {
      return origin.request<CreateServerResult>(original, "/api/community/servers", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: (_data, args) => {
      // The server row includes owner/role metadata we don't get from the
      // response — refetch to hydrate the rail correctly.
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), predicate: (query) => args.resources.includes(query) })
    },
  })
}

// ── Join server (via invite token) ─────────────────────────────────────────

export type JoinServerArgs = { inviteCode: string }
export type JoinServerResult = { serverId: string }

export function useJoinServer() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  return useCommunityCommandMutation<JoinServerResult, Error, JoinServerArgs>(origin, {
    mutationFn: async ({ inviteCode, original }) => {
      let token = inviteCode.trim()
      try {
        const url = new URL(token)
        const segments = url.pathname.split("/").filter(Boolean)
        const inviteIdx = segments.indexOf("invite")
        if (inviteIdx !== -1 && segments[inviteIdx + 1]) {
          token = segments[inviteIdx + 1]
        }
      } catch {
        // Not a URL — raw token.
      }
      return origin.request<JoinServerResult>(
        original, `/api/community/invites/${token}/join`,
        { method: "POST" },
      )
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), predicate: (query) => args.resources.includes(query) })
    },
  })
}

// ── Leave / delete server ──────────────────────────────────────────────────

export type LeaveServerArgs = { serverId: string }
type DeleteServerCallbacks = {
  routeToken: OwnerServerDeleteRouteToken
  onSuccess?: (
    args: LeaveServerArgs,
    result: { needsNavigation: boolean },
  ) => void
  onError?: (error: Error, args: LeaveServerArgs) => void
}

function mutateViewerMembership(registry: NonNullable<ReturnType<typeof useCommunityMutationOrigin>["registry"]>, serverId: string) {
  for (const row of registry.collections.serverMemberships.values()) if (row.serverId === serverId && row.viewer && row.userId === registry.accountId) registry.collections.serverMemberships.delete(row.id)
}

export function useLeaveServer() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  const assertLeaveSuccess = useCallback((args: CommunityCommandArgs<LeaveServerArgs>) => origin.assertOwner(args.original), [origin])
  return useCommunityCommandMutation<void, Error, LeaveServerArgs, { token: AccountUnreadScopeToken; proof: CommunityLiveSnapshotToken }>(origin, {
    scope: { id: "community-server-membership" },
    onMutate: async (args) => {
      const token = args.original
      await origin.registry?.ready
      origin.assert(token)
      return { proof: token, token: unreadProjection.beginScopeRetirement({ kind: "server", serverId: args.serverId }) }
    },
    mutationFn: async (args) => {
      const original = args.original, registry = origin.registry!
      origin.assert(original)
      await queryClient.cancelQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) })
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const transaction = registry.dbClient.createTransaction({ mutationFn: async () => {
        try {
          await apiFetch(`/api/community/servers/${args.serverId}/leave`, { method: "POST", ...communityRequestOptions(queryClient, token, undefined, () => origin.assert(token)) })
          origin.assert(token)
          publishCommunityServerMembershipRemoval(queryClient, args.serverId, { token, signal: undefined })
        } catch (error) { origin.assert(token); throw error }
      } })
      transaction.mutate(() => mutateViewerMembership(registry, args.serverId))
      try { await transaction.isPersisted.promise } catch (error) { origin.assert(token); throw error }
    },
    onError: (_error, _args, context) => {
      if (!context) return
      try { origin.assert(context.proof) } catch { return }
      unreadProjection.rollbackScopeRetirement(context.token)
    },
    onSuccess: (_data, args, context) => {
      origin.assert(context.proof)
      unreadProjection.commitScopeRetirement(context.token)
      evictServerChannelScopes(queryClient, args.serverId)
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelRefDirectory(), exact: true, predicate: (query) => args.resources.includes(query) })
    },
  }, assertLeaveSuccess)
}

export function useDeleteServer(callbacks: DeleteServerCallbacks) {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  return useCommunityCommandMutation<void, Error, LeaveServerArgs, { token: AccountUnreadScopeToken; proof: CommunityLiveSnapshotToken } & DeleteServerCallbacks>(origin, {
    scope: { id: "community-server-membership" },
    onMutate: async (args) => {
      const token = args.original
      await origin.registry?.ready
      origin.assert(token)
      beginOwnerServerDelete(queryClient, args.serverId, callbacks.routeToken)
      return { ...callbacks, proof: token, token: unreadProjection.beginScopeRetirement({ kind: "server", serverId: args.serverId }) }
    },
    mutationFn: async (args) => {
      const original = args.original, registry = origin.registry!
      origin.assert(original)
      await queryClient.cancelQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) })
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const transaction = registry.dbClient.createTransaction({ mutationFn: async () => {
        try {
          await apiFetch(`/api/community/servers/${args.serverId}`, { method: "DELETE", ...communityRequestOptions(queryClient, token, undefined, () => origin.assert(token)) })
          origin.assert(token)
          publishCommunityServerMembershipRemoval(queryClient, args.serverId, { token, signal: undefined })
        } catch (error) { origin.assert(token); throw error }
      } })
      transaction.mutate(() => mutateViewerMembership(registry, args.serverId))
      try { await transaction.isPersisted.promise } catch (error) { origin.assert(token); throw error }
    },
    onError: (error, args, context) => {
      cancelOwnerServerDelete(queryClient, args.serverId, context?.routeToken)
      if (!context) return
      try { origin.assert(context.proof) } catch { return }
      unreadProjection.rollbackScopeRetirement(context.token)
      context.onError?.(error, communityCommandInput(args))
    },
    onSuccess: (_data, args, context) => {
      origin.assert(context.proof)
      const ready = commitOwnerServerDelete(queryClient, args.serverId, context.routeToken)
      unreadProjection.commitScopeRetirement(context.token)
      if (ready) flushOwnerServerDeleteAfterSuccess(queryClient, args.serverId)
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelRefDirectory(), exact: true, predicate: (query) => args.resources.includes(query) })
      if (origin.registry?.authenticationView.get().active) context.onSuccess?.(communityCommandInput(args), { needsNavigation: !ready })
    },
  })
}

// ── Update server (name + description) ─────────────────────────────────────

export type UpdateServerArgs = {
  serverId: string
  name: string
  description: string
}

export function useUpdateServer() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, UpdateServerArgs>(origin, {
    scope: { id: "community-server-fields" },
    mutationFn: async (args) => {
      const original = args.original, registry = origin.registry
      await registry?.ready
      origin.assert(original)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: communityKeys.server(args.serverId), exact: true, predicate: (query) => args.resources.includes(query) }),
        queryClient.cancelQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) }),
      ])
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const persist = async () => {
        try {
          const result = await apiFetch<{ name: string; description: string }>(`/api/community/servers/${args.serverId}`, {
            method: "PATCH", body: JSON.stringify({ name: args.name, description: args.description }),
            ...communityRequestOptions(queryClient, token, undefined, () => origin.assert(original)),
          })
          origin.assert(original)
          publishCommunityServerFields(queryClient, args.serverId, { name: result.name, description: result.description }, { token, signal: undefined })
        } catch (error) { origin.assert(original); throw error }
      }
      if (!registry!.collections.servers.has(args.serverId)) return persist()
      const transaction = registry!.dbClient.createTransaction({ mutationFn: persist })
      transaction.mutate(() => registry!.collections.servers.update(args.serverId, (row) => { row.name = args.name.trim(); row.description = args.description }))
      try { await transaction.isPersisted.promise } catch (error) { origin.assert(original); throw error }
    },
    onSettled: (_data, error, args) => {
      if (isAbortError(error) || !origin.registry?.runtime.lifecycle.get().active) return
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId), exact: true, predicate: (query) => args.resources.includes(query) })
      void queryClient.invalidateQueries({ queryKey: communityKeys.channelRefDirectory(), exact: true, predicate: (query) => args.resources.includes(query) })
    },
  })
}

// ── Upload server icon ─────────────────────────────────────────────────────

export type UploadServerIconArgs = { serverId: string; file: File }
export type UploadServerIconResult = { url: string }

export function useUploadServerIcon() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<UploadServerIconResult, Error, UploadServerIconArgs>(origin, {
    scope: { id: "community-server-fields" },
    mutationFn: async (args) => {
      const { serverId, file, original } = args
      origin.assert(original)
      await origin.registry?.ready
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const formData = new FormData()
      formData.append("file", file)
      try {
        const result = await apiFetch<UploadServerIconResult>(`/api/community/servers/${serverId}/icon`, {
          method: "POST", body: formData,
          ...communityRequestOptions(queryClient, token, undefined, () => origin.assert(token)),
        })
        origin.assert(token)
        publishCommunityServerFields(queryClient, serverId, { icon: `${result.url}?t=${Date.now()}` }, { token, signal: undefined })
        return result
      } catch (error) { origin.assert(token); throw error }
    },
    onSettled: (_data, error, args) => {
      if (isAbortError(error) || !origin.registry?.runtime.lifecycle.get().active) return
      void queryClient.invalidateQueries({ queryKey: communityKeys.servers(), exact: true, predicate: (query) => args.resources.includes(query) })
    },
  })
}
