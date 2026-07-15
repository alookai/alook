"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { nanoid } from "nanoid"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ServerDetail } from "@/hooks/community/use-servers"
import { UNCATEGORIZED_CATEGORY_ID, type ChannelType } from "@alook/shared"

// Prefix marks an optimistic row so every consumer can tell it from a real
// `ch_…` id without a separate flag, and guarantees it never collides with one.
const tempChannelId = () => `tmp_ch_${nanoid()}`

// A create can name the uncategorized target three ways: `null`, `""` (the
// sidebar's fallback when no synthetic bucket exists yet), or the synthetic
// bucket id itself (once one does). All mean "top level".
const isUncategorizedTarget = (categoryId: string | null) =>
  !categoryId || categoryId === UNCATEGORIZED_CATEGORY_ID

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
  categoryId: string | null
  name: string
  type: ChannelType
}
export type CreateChannelResult = { channel: { id: string } }

type CreateChannelCtx = { snapshot?: ServerDetail; tempId: string }

/**
 * Optimistically inserts a pending channel row into the target category so the
 * sidebar shows immediate feedback, then reconciles on settle. `onMutate`
 * writes a `tmp_ch_…` row; `onSuccess` swaps its id for the real one (so
 * auto-navigation highlights the active row before the refetch lands);
 * `onError` rolls back; `onSettled` invalidates so the tree resettles to server
 * truth (real ids, positions, slug-normalized name). The WS `channel.create`
 * broadcast also invalidates `server(serverId)` — TanStack de-dupes the
 * concurrent refetch, so no duplicate row.
 */
export function useCreateChannel() {
  const queryClient = useQueryClient()
  return useMutation<CreateChannelResult, Error, CreateChannelArgs, CreateChannelCtx>({
    mutationFn: async ({ serverId, categoryId, name, type }) => {
      // The uncategorized bucket is a synthetic id, not a real category row —
      // send `null` so the server doesn't 404 on `getCategory`. onMutate still
      // uses the bucket to place the optimistic row in the cache.
      const apiCategoryId = isUncategorizedTarget(categoryId) ? null : categoryId
      return apiFetch<CreateChannelResult>(
        `/api/community/servers/${serverId}/channels`,
        { method: "POST", body: JSON.stringify({ categoryId: apiCategoryId, name, type }) },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.server(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<ServerDetail>(key)
      const tempId = tempChannelId()
      const pending = {
        id: tempId,
        name: args.name.trim(),
        active: false,
        unread: false,
        type: args.type,
        creatorId: null,
        pending: true,
      }
      queryClient.setQueryData<ServerDetail>(key, (prev) => {
        if (!prev) return prev
        const uncategorized = isUncategorizedTarget(args.categoryId)
        // Resolve which cache category to attach to: the named one, or the
        // synthetic uncategorized bucket (matched by id OR the empty-name
        // convention the server-detail response uses).
        const target = prev.categories.find((c) =>
          uncategorized ? (c.id === UNCATEGORIZED_CATEGORY_ID || c.name === "") : c.id === args.categoryId,
        )
        if (target) {
          return {
            ...prev,
            categories: prev.categories.map((c) =>
              c === target ? { ...c, channels: [...c.channels, pending] } : c,
            ),
          }
        }
        // First top-level channel: no synthetic bucket exists yet. Synthesize
        // one so the pending row shows immediately; the settle refetch replaces
        // it with the server's real uncategorized bucket.
        if (uncategorized) {
          return {
            ...prev,
            categories: [
              ...prev.categories,
              { id: UNCATEGORIZED_CATEGORY_ID, name: "", channels: [pending] } as ServerDetail["categories"][number],
            ],
          }
        }
        return prev
      })
      return { snapshot, tempId }
    },
    onSuccess: (data, args, ctx) => {
      const key = communityKeys.server(args.serverId)
      queryClient.setQueryData<ServerDetail>(key, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          categories: prev.categories.map((c) => ({
            ...c,
            channels: c.channels.map((ch) =>
              ch.id === ctx.tempId ? { ...ch, id: data.channel.id, pending: false } : ch,
            ),
          })),
        }
      })
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.server(args.serverId), ctx.snapshot)
    },
    onSettled: (_data, _err, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type MoveChannelArgs = {
  serverId: string
  channelId: string
  categoryId: string | null
}

/**
 * Move a channel to another category (or to uncategorized with `null`). The
 * backend (`channels/[id]` PATCH) is admin-only and rejects a move that would
 * cross a public↔private boundary — the sidebar blocks that before it gets
 * here, this mutation covers the same-privacy case. Invalidates the tree so
 * positions/category resettle from the server.
 */
export function useMoveChannel() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, MoveChannelArgs>({
    mutationFn: async ({ channelId, categoryId }) => {
      await apiFetch(`/api/community/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId }),
      })
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

const tempCategoryId = () => `tmp_cat_${nanoid()}`

type CreateCategoryCtx = { snapshot?: ServerDetail; tempId: string }

/**
 * Optimistically appends a pending category so the sidebar shows it
 * immediately, then reconciles on settle — mirrors `useCreateChannel`.
 * `onSuccess` swaps the temp id for the real one; `onError` rolls back;
 * `onSettled` invalidates so the tree resettles to server truth.
 */
export function useCreateCategory() {
  const queryClient = useQueryClient()
  return useMutation<CreateCategoryResult, Error, CreateCategoryArgs, CreateCategoryCtx>({
    mutationFn: async ({ serverId, name, private: isPrivate }) => {
      return apiFetch<CreateCategoryResult>(
        `/api/community/servers/${serverId}/categories`,
        { method: "POST", body: JSON.stringify({ name, private: isPrivate }) },
      )
    },
    onMutate: async (args) => {
      const key = communityKeys.server(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<ServerDetail>(key)
      const tempId = tempCategoryId()
      queryClient.setQueryData<ServerDetail>(key, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          categories: [
            ...prev.categories,
            {
              id: tempId,
              name: args.name.trim(),
              private: args.private ? 1 : 0,
              channels: [],
              pending: true,
            } as ServerDetail["categories"][number],
          ],
        }
      })
      return { snapshot, tempId }
    },
    onSuccess: (data, args, ctx) => {
      queryClient.setQueryData<ServerDetail>(communityKeys.server(args.serverId), (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          categories: prev.categories.map((c) =>
            c.id === ctx.tempId ? { ...c, id: data.category.id, pending: false } : c,
          ),
        }
      })
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.server(args.serverId), ctx.snapshot)
    },
    onSettled: (_data, _err, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

// Category privacy is immutable after creation, so this only renames.
export type UpdateCategoryArgs = {
  serverId: string
  categoryId: string
  name?: string
}

export function useUpdateCategory() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, UpdateCategoryArgs>({
    mutationFn: async ({ serverId, categoryId, name }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
    },
    onSuccess: (_data, args) => {
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId) })
    },
  })
}

export type DeleteCategoryArgs = { serverId: string; categoryId: string }

/**
 * Optimistically drops the category from the cache, then reconciles on settle.
 * Rollback on error is essential here: the server rejects deleting a non-empty
 * category (409 "Move or delete its channels first"), and without a rollback
 * the still-existing category would vanish from the sidebar until an unrelated
 * refetch. The tree is cache-derived, so the cache removal IS the optimistic UI
 * — the sidebar no longer mutates local tree state for a delete.
 */
export function useDeleteCategory() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteCategoryArgs, { snapshot?: ServerDetail }>({
    mutationFn: async ({ serverId, categoryId }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const key = communityKeys.server(args.serverId)
      await queryClient.cancelQueries({ queryKey: key })
      const snapshot = queryClient.getQueryData<ServerDetail>(key)
      queryClient.setQueryData<ServerDetail>(key, (prev) => {
        if (!prev) return prev
        return { ...prev, categories: prev.categories.filter((c) => c.id !== args.categoryId) }
      })
      return { snapshot }
    },
    onError: (_err, args, ctx) => {
      if (ctx?.snapshot) queryClient.setQueryData(communityKeys.server(args.serverId), ctx.snapshot)
    },
    onSettled: (_data, _err, args) => {
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
