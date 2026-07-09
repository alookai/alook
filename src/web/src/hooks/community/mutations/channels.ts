"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ChannelType } from "@alook/shared"

/**
 * Channel / category CRUD + reorders. These all invalidate `server(serverId)`
 * so the tree re-renders with fresh category/channel positions. The WS layer
 * mirrors this with its own `invalidateQueries(server(id))` on
 * `channel.*` / `category.*` events, so success paths here still need a
 * same-tab invalidation for the mutating client.
 */

// ── Channels ──────────────────────────────────────────────────────────────

export type CreateChannelArgs = {
  serverId: string
  categoryId: string
  name: string
  type: ChannelType
}
export type CreateChannelResult = { channel: { id: string } }

export function useCreateChannel() {
  const queryClient = useQueryClient()
  return useMutation<CreateChannelResult, Error, CreateChannelArgs>({
    mutationFn: async ({ serverId, categoryId, name, type }) => {
      return apiFetch<CreateChannelResult>(
        `/api/community/servers/${serverId}/channels`,
        { method: "POST", body: JSON.stringify({ categoryId, name, type }) },
      )
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type DeleteChannelArgs = { serverId: string; channelId: string }

export function useDeleteChannel() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteChannelArgs>({
    mutationFn: async ({ channelId }) => {
      await apiFetch(`/api/community/channels/${channelId}`, { method: "DELETE" })
    },
    onSuccess: (_data, args) => {
      if (args.serverId) {
        void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
      }
    },
  })
}

// ── Categories ────────────────────────────────────────────────────────────

export type CreateCategoryArgs = {
  serverId: string
  name: string
  private?: boolean
}
export type CreateCategoryResult = { category: { id: string } }

export function useCreateCategory() {
  const queryClient = useQueryClient()
  return useMutation<CreateCategoryResult, Error, CreateCategoryArgs>({
    mutationFn: async ({ serverId, name, private: isPrivate }) => {
      return apiFetch<CreateCategoryResult>(
        `/api/community/servers/${serverId}/categories`,
        { method: "POST", body: JSON.stringify({ name, private: isPrivate }) },
      )
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type UpdateCategoryArgs = {
  serverId: string
  categoryId: string
  name?: string
  isPrivate?: boolean
}

export function useUpdateCategory() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, UpdateCategoryArgs>({
    mutationFn: async ({ serverId, categoryId, name, isPrivate }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "PATCH",
        body: JSON.stringify({ name, private: isPrivate }),
      })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type DeleteCategoryArgs = { serverId: string; categoryId: string }

export function useDeleteCategory() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteCategoryArgs>({
    mutationFn: async ({ serverId, categoryId }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "DELETE",
      })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

// ── Reorders ──────────────────────────────────────────────────────────────

export type ReorderServersArgs = { serverIds: string[] }

/**
 * Optimistically reorder the rail; roll back on failure. The rail's order is
 * pure UX — the WS doesn't broadcast reorders, so the same-tab optimistic
 * write is the only signal cross-tab clients get.
 */
export function useReorderServers() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, ReorderServersArgs, { snapshot: unknown }>({
    mutationFn: async ({ serverIds }) => {
      await apiFetch("/api/community/servers/reorder", {
        method: "PATCH",
        body: JSON.stringify({ serverIds }),
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.servers()
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData(key)
      queryClient.setQueryData(key, (prev: { servers: { id: string }[] } | undefined) => {
        if (!prev) return prev
        const map = new Map(prev.servers.map((s) => [s.id, s]))
        return {
          ...prev,
          servers: args.serverIds
            .map((id) => map.get(id))
            .filter((s): s is NonNullable<typeof s> => Boolean(s)),
        }
      })
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.servers(), ctx.snapshot)
    },
  })
}

export type ReorderCategoriesArgs = { serverId: string; categoryIds: string[] }

export function useReorderCategories() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, ReorderCategoriesArgs>({
    mutationFn: async ({ serverId, categoryIds }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ categoryIds }),
      })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type ReorderChannelsArgs = { serverId: string; channelIds: string[] }

export function useReorderChannels() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, ReorderChannelsArgs>({
    mutationFn: async ({ serverId, channelIds }) => {
      await apiFetch(`/api/community/servers/${serverId}/channels/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ channelIds }),
      })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}
