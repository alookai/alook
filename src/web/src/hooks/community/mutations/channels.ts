"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { nanoid } from "nanoid"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { UNCATEGORIZED_CATEGORY_ID, type ChannelType } from "@alook/shared"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { runCommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import { projectChannelScopeEviction } from "@/hooks/community/community-ws/channel-scope-projection"
import { getCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { serverDetailResourceKey } from "@/lib/community-db/server-detail-resource"
import type { CategoryRow, ChannelRow } from "@/lib/community-db/schema"

// Prefix marks an optimistic row so every consumer can tell it from a real
// `ch_…` id without a separate flag, and guarantees it never collides with one.
const tempChannelId = () => `tmp_ch_${nanoid()}`

// A create can name the uncategorized target three ways: `null`, `""` (the
// sidebar's fallback when no synthetic bucket exists yet), or the synthetic
// bucket id itself (once one does). All mean "top level".
const isUncategorizedTarget = (categoryId: string | null) =>
  !categoryId || categoryId === UNCATEGORIZED_CATEGORY_ID

function invalidateChannelRefDirectory(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({
    queryKey: communityKeys.channelRefDirectory(),
    exact: true,
  })
}

function serverDetailKey(
  queryClient: ReturnType<typeof useQueryClient>,
  serverId: string,
) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? serverDetailResourceKey(registry.scopeId, serverId) : null
}

function invalidateServerDetail(
  queryClient: ReturnType<typeof useQueryClient>,
  serverId: string,
) {
  const key = serverDetailKey(queryClient, serverId)
  if (key) void queryClient.invalidateQueries({ queryKey: key, exact: true })
}

type ServerTreeSnapshot = {
  categories: CategoryRow[]
  channels: ChannelRow[]
}

function snapshotServerTree(
  registry: CommunityDbRegistry | null,
  serverId: string,
): ServerTreeSnapshot | undefined {
  if (!registry) return undefined
  return {
    categories: [...registry.collections.categories.values()]
      .filter((row) => row.serverId === serverId),
    channels: [...registry.collections.channels.values()]
      .filter((row) => row.serverId === serverId && row.type !== "thread"),
  }
}

function restoreServerTree(
  registry: CommunityDbRegistry | null,
  serverId: string,
  snapshot: ServerTreeSnapshot | undefined,
) {
  if (!registry || !snapshot) return
  registry.collections.categories.utils.writeBatch(() => {
    const snapshotById = new Map(snapshot.categories.map((row) => [row.id, row]))
    const currentIds = new Set<string>()
    for (const row of registry.collections.categories.values()) {
      if (row.serverId !== serverId) continue
      currentIds.add(row.id)
      const restored = snapshotById.get(row.id)
      if (restored) registry.collections.categories.utils.writeUpdate(restored)
      else registry.collections.categories.utils.writeDelete(row.id)
    }
    for (const row of snapshot.categories) {
      if (!currentIds.has(row.id)) registry.collections.categories.utils.writeInsert(row)
    }
  })
  registry.collections.channels.utils.writeBatch(() => {
    const snapshotById = new Map(snapshot.channels.map((row) => [row.id, row]))
    const currentIds = new Set<string>()
    for (const row of registry.collections.channels.values()) {
      if (row.serverId !== serverId || row.type === "thread") continue
      currentIds.add(row.id)
      const restored = snapshotById.get(row.id)
      if (restored) registry.collections.channels.utils.writeUpdate(restored)
      else registry.collections.channels.utils.writeDelete(row.id)
    }
    for (const row of snapshot.channels) {
      if (!currentIds.has(row.id)) registry.collections.channels.utils.writeInsert(row)
    }
  })
}

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

type CreateChannelCtx = { snapshot?: ServerTreeSnapshot; tempId: string }

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
      // Unified create door (route/disc create-door step): POST /channels with a
      // type-discriminated descriptor. text/forum carries serverId + name.
      return apiFetch<CreateChannelResult>(
        `/api/community/channels`,
        { method: "POST", body: JSON.stringify({ type, serverId, categoryId: apiCategoryId, name }) },
      )
    },
    onMutate: async (args) => {
      const key = serverDetailKey(queryClient, args.serverId)
      if (key) await queryClient.cancelQueries({ queryKey: key, exact: true })
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = snapshotServerTree(registry, args.serverId)
      const tempId = tempChannelId()
      const uncategorized = isUncategorizedTarget(args.categoryId)
      const categoryId = uncategorized ? null : args.categoryId
      const categoryExists = categoryId === null || registry?.collections.categories.has(categoryId)
      const position = [...(registry?.collections.channels.values() ?? [])]
        .filter((row) => row.serverId === args.serverId && row.categoryId === categoryId)
        .length
      const pending: ChannelRow = {
        id: tempId,
        serverId: args.serverId,
        categoryId,
        name: args.name.trim(),
        type: args.type,
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        position,
        archived: false,
        muted: false,
        unread: false,
        tags: [],
        pending: true,
        lastMessageAt: null,
      }
      if (registry && categoryExists) registry.collections.channels.utils.writeUpsert(pending)
      return { snapshot, tempId }
    },
    onSuccess: (data, _args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      const pending = registry?.collections.channels.get(ctx.tempId)
      if (registry && pending) {
        registry.collections.channels.utils.writeBatch(() => {
          registry.collections.channels.utils.writeDelete(ctx.tempId)
          registry.collections.channels.utils.writeUpsert({
            ...pending,
            id: data.channel.id,
            pending: false,
          })
        })
      }
    },
    onError: (_err, args, ctx) => {
      restoreServerTree(getCommunityDbRegistry(queryClient), args.serverId, ctx?.snapshot)
    },
    onSettled: (_data, _err, args) => {
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
    },
  })
}

export type MoveChannelArgs = {
  serverId: string
  channelId: string
  categoryId: string | null
}

export type RenameChannelArgs = {
  serverId: string
  channelId: string
  name: string
}
export type RenameChannelResult = { id: string; name: string }

type RenameChannelCtx = {
  snapshot?: ChannelRow
}

export function useRenameChannel() {
  const queryClient = useQueryClient()
  return useMutation<RenameChannelResult, Error, RenameChannelArgs, RenameChannelCtx>({
    mutationFn: async ({ channelId, name }) => {
      return apiFetch<RenameChannelResult>(`/api/community/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      })
    },
    onMutate: async (args) => {
      const serverKey = serverDetailKey(queryClient, args.serverId)
      const directoryKey = communityKeys.channelRefDirectory()
      await Promise.all([
        ...(serverKey
          ? [queryClient.cancelQueries({ queryKey: serverKey, exact: true })]
          : []),
        queryClient.cancelQueries({ queryKey: directoryKey, exact: true }),
      ])
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = registry?.collections.channels.get(args.channelId)
      const optimisticName = args.name.trim()
      if (snapshot) registry?.collections.channels.utils.writeUpdate({
        id: args.channelId,
        name: optimisticName,
      })
      return { snapshot }
    },
    onSuccess: (data, args) => {
      const registry = getCommunityDbRegistry(queryClient)
      if (registry?.collections.channels.has(args.channelId)) {
        registry.collections.channels.utils.writeUpdate({ id: args.channelId, name: data.name })
      }
    },
    onError: (_err, _args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry?.collections.channels.has(ctx.snapshot.id)) {
        registry.collections.channels.utils.writeUpdate(ctx.snapshot)
      }
    },
    onSettled: (_data, _err, args) => {
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
    },
  })
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
      const registry = getCommunityDbRegistry(queryClient)
      if (registry?.collections.channels.has(args.channelId)) {
        registry.collections.channels.utils.writeUpdate({
          id: args.channelId,
          categoryId: isUncategorizedTarget(args.categoryId) ? null : args.categoryId,
        })
      }
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
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
      getActiveAccountUnreadProjection(queryClient).retireAccessScope({
        kind: "channel",
        channelId: args.channelId,
      })
      if (args.serverId) {
        runCommunityWsProjectionTransaction(queryClient, (projection) => {
          projectChannelScopeEviction(
            projection,
            queryClient,
            args.serverId,
            args.channelId,
          )
        })
        invalidateServerDetail(queryClient, args.serverId)
      }
      invalidateChannelRefDirectory(queryClient)
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

type CreateCategoryCtx = { snapshot?: ServerTreeSnapshot; tempId: string }

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
      const key = serverDetailKey(queryClient, args.serverId)
      if (key) await queryClient.cancelQueries({ queryKey: key, exact: true })
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = snapshotServerTree(registry, args.serverId)
      const tempId = tempCategoryId()
      if (registry) {
        const position = [...registry.collections.categories.values()]
          .filter((row) => row.serverId === args.serverId)
          .length
        registry.collections.categories.utils.writeUpsert({
          id: tempId,
          serverId: args.serverId,
          name: args.name.trim(),
          position,
          private: args.private === true,
          creatorId: null,
          pending: true,
        })
      }
      return { snapshot, tempId }
    },
    onSuccess: (data, _args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      const pending = registry?.collections.categories.get(ctx.tempId)
      if (registry && pending) {
        registry.collections.categories.utils.writeBatch(() => {
          registry.collections.categories.utils.writeDelete(ctx.tempId)
          registry.collections.categories.utils.writeUpsert({
            ...pending,
            id: data.category.id,
            pending: false,
          })
        })
      }
    },
    onError: (_err, args, ctx) => {
      restoreServerTree(getCommunityDbRegistry(queryClient), args.serverId, ctx?.snapshot)
    },
    onSettled: (_data, _err, args) => {
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
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
      const registry = getCommunityDbRegistry(queryClient)
      if (args.name !== undefined && registry?.collections.categories.has(args.categoryId)) {
        registry.collections.categories.utils.writeUpdate({
          id: args.categoryId,
          name: args.name,
        })
      }
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
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
  return useMutation<void, Error, DeleteCategoryArgs, { snapshot?: CategoryRow }>({
    mutationFn: async ({ serverId, categoryId }) => {
      await apiFetch(`/api/community/servers/${serverId}/categories/${categoryId}`, {
        method: "DELETE",
      })
    },
    onMutate: async (args) => {
      const key = serverDetailKey(queryClient, args.serverId)
      if (key) await queryClient.cancelQueries({ queryKey: key, exact: true })
      const registry = getCommunityDbRegistry(queryClient)
      const snapshot = registry?.collections.categories.get(args.categoryId)
      if (snapshot) registry?.collections.categories.utils.writeDelete(args.categoryId)
      return { snapshot }
    },
    onError: (_err, _args, ctx) => {
      const registry = getCommunityDbRegistry(queryClient)
      if (ctx?.snapshot && registry && !registry.collections.categories.has(ctx.snapshot.id)) {
        registry.collections.categories.utils.writeInsert(ctx.snapshot)
      }
    },
    onSettled: (_data, _err, args) => {
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
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
      const registry = getCommunityDbRegistry(queryClient)
      const positions = new Map(args.categoryIds.map((id, position) => [id, position]))
      registry?.collections.categories.utils.writeBatch(() => {
        for (const [id, position] of positions) {
          if (registry.collections.categories.has(id)) {
            registry.collections.categories.utils.writeUpdate({ id, position })
          }
        }
      })
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
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
      const registry = getCommunityDbRegistry(queryClient)
      const positions = new Map(args.channelIds.map((id, position) => [id, position]))
      registry?.collections.channels.utils.writeBatch(() => {
        for (const [id, position] of positions) {
          if (registry.collections.channels.has(id)) {
            registry.collections.channels.utils.writeUpdate({ id, position })
          }
        }
      })
      invalidateServerDetail(queryClient, args.serverId)
      invalidateChannelRefDirectory(queryClient)
    },
  })
}
