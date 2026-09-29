"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch, readUploadError } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import type { ServerRow } from "@/lib/community-db/schema"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
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

/**
 * Server-scoped mutations. `create`/`join` invalidate the rail; `leave`/`delete`
 * optimistically prune the rail. `update` patches the server detail cache
 * directly so the settings surface reflects the change immediately.
 */

// ── Create server ──────────────────────────────────────────────────────────

export type CreateServerArgs = { name: string }
export type CreateServerResult = { server: { id: string } }

export function useCreateServer() {
  const queryClient = useQueryClient()
  return useMutation<CreateServerResult, Error, CreateServerArgs>({
    mutationFn: async ({ name }) => {
      return apiFetch<CreateServerResult>("/api/community/servers", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: () => {
      void (getCommunityDbRegistry(queryClient)?.requestServerRefetch()
        ?? queryClient.invalidateQueries({ queryKey: serversCollectionQueryKey(), exact: true }))
    },
  })
}

// ── Join server (via invite token) ─────────────────────────────────────────

export type JoinServerArgs = { inviteCode: string }
export type JoinServerResult = { serverId: string }

export function useJoinServer() {
  const queryClient = useQueryClient()
  return useMutation<JoinServerResult, Error, JoinServerArgs>({
    mutationFn: async ({ inviteCode }) => {
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
      return apiFetch<JoinServerResult>(
        `/api/community/invites/${token}/join`,
        { method: "POST" },
      )
    },
    onSuccess: () => {
      void (getCommunityDbRegistry(queryClient)?.requestServerRefetch()
        ?? queryClient.invalidateQueries({ queryKey: serversCollectionQueryKey(), exact: true }))
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

export function useLeaveServer() {
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  return useMutation<void, Error, LeaveServerArgs, {
    snapshot: ServerRow | undefined
    token: AccountUnreadScopeToken
  }>({
    mutationFn: async ({ serverId }) => {
      await apiFetch(`/api/community/servers/${serverId}/leave`, { method: "POST" })
    },
    onMutate: async (args) => {
      const key = serversCollectionQueryKey()
      await queryClient.cancelQueries({ queryKey: key })
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = registry?.collections.servers.get(args.serverId)
      if (snapshot) registry?.collections.servers.utils.writeDelete(args.serverId)
      return {
        snapshot,
        token: unreadProjection.beginScopeRetirement({ kind: "server", serverId: args.serverId }),
      }
    },
    onError: (_err, _args, ctx) => {
      if (ctx) unreadProjection.rollbackScopeRetirement(ctx.token)
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry && !registry.collections.servers.has(ctx.snapshot.id)) {
        registry.collections.servers.utils.writeInsert(ctx.snapshot)
      }
    },
    onSuccess: (_data, args, context) => {
      unreadProjection.commitScopeRetirement(context.token)
      evictServerChannelScopes(queryClient, args.serverId)
      void queryClient.invalidateQueries({
        queryKey: communityKeys.channelRefDirectory(),
        exact: true,
      })
    },
  })
}

export function useDeleteServer(callbacks: DeleteServerCallbacks) {
  const queryClient = useQueryClient()
  const unreadProjection = getActiveAccountUnreadProjection(queryClient)
  return useMutation<void, Error, LeaveServerArgs, {
    snapshot: ServerRow | undefined
    token: AccountUnreadScopeToken
    routeToken: OwnerServerDeleteRouteToken
    onSuccess: DeleteServerCallbacks["onSuccess"]
    onError: DeleteServerCallbacks["onError"]
  }>({
    mutationFn: async ({ serverId }) => {
      await apiFetch(`/api/community/servers/${serverId}`, { method: "DELETE" })
    },
    onMutate: async (args) => {
      beginOwnerServerDelete(args.serverId, callbacks.routeToken)
      const key = serversCollectionQueryKey()
      await queryClient.cancelQueries({ queryKey: key })
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = registry?.collections.servers.get(args.serverId)
      if (snapshot) registry?.collections.servers.utils.writeDelete(args.serverId)
      return {
        snapshot,
        token: unreadProjection.beginScopeRetirement({ kind: "server", serverId: args.serverId }),
        routeToken: callbacks.routeToken,
        onSuccess: callbacks.onSuccess,
        onError: callbacks.onError,
      }
    },
    onError: (error, args, ctx) => {
      if (ctx) unreadProjection.rollbackScopeRetirement(ctx.token)
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry && !registry.collections.servers.has(ctx.snapshot.id)) {
        registry.collections.servers.utils.writeInsert(ctx.snapshot)
      }
      cancelOwnerServerDelete(args.serverId, ctx?.routeToken ?? callbacks.routeToken)
      const onError = ctx?.onError ?? callbacks.onError
      onError?.(error, args)
    },
    onSuccess: (_data, args, context) => {
      const scopeFlushReady = commitOwnerServerDelete(args.serverId, context.routeToken)
      unreadProjection.commitScopeRetirement(context.token)
      if (scopeFlushReady) {
        flushOwnerServerDeleteAfterSuccess(queryClient, args.serverId)
      }
      void queryClient.invalidateQueries({
        queryKey: communityKeys.channelRefDirectory(),
        exact: true,
      })
      context.onSuccess?.(args, { needsNavigation: !scopeFlushReady })
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
  const queryClient = useQueryClient()
  return useMutation<
    void,
    Error,
    UpdateServerArgs,
    { rowSnap: ServerRow | undefined }
  >({
    mutationFn: async ({ serverId, name, description }) => {
      await apiFetch(`/api/community/servers/${serverId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description }),
      })
    },
    onMutate: async (args) => {
      const listKey = serversCollectionQueryKey()
      await queryClient.cancelQueries({ queryKey: listKey })
      const registry = getCommunityDbRegistry(queryClient)
      const rowSnap = registry?.collections.servers.get(args.serverId)
      if (rowSnap) {
        registry?.collections.servers.utils.writeUpdate({
          id: args.serverId,
          name: args.name,
          description: args.description,
        })
      }
      return { rowSnap }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.rowSnap) {
        getCommunityDbRegistry(queryClient)?.collections.servers.utils.writeUpdate(ctx.rowSnap)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: communityKeys.channelRefDirectory(),
        exact: true,
      })
    },
  })
}

// ── Upload server icon ─────────────────────────────────────────────────────

export type UploadServerIconArgs = { serverId: string; file: File }
export type UploadServerIconResult = { url: string }

export function useUploadServerIcon() {
  const queryClient = useQueryClient()
  return useMutation<UploadServerIconResult, Error, UploadServerIconArgs>({
    mutationFn: async ({ serverId, file }) => {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`/api/community/servers/${serverId}/icon`, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      if (!res.ok) throw await readUploadError(res, "Upload failed")
      return (await res.json()) as UploadServerIconResult
    },
    onSuccess: (data, args) => {
      const bustUrl = `${data.url}?t=${Date.now()}`
      const registry = getCommunityDbRegistry(queryClient)
      if (registry?.collections.servers.has(args.serverId)) {
        registry.collections.servers.utils.writeUpdate({ id: args.serverId, icon: bustUrl })
      }
    },
  })
}
