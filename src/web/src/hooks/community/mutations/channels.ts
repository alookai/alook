"use client"

import { useCommunityCommandMutation, type CommunityCommandArgs } from "../use-community-command-mutation"
import { beginCommunityCommandRevision } from "@/lib/community-db/sync"
import { useCommunityMutationOrigin } from "../community-origin"
import { useQueryClient } from "@tanstack/react-query"
import { nanoid } from "nanoid"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import {
  publishCommunityChannelPatch, publishCommunityChannelFields, publishCommunityCategoryFields,
  publishCommunityCreatedChannel, publishCommunityCreatedCategory, publishCommunityDeletedCategory,
  type CommunityFreshQueryProof,
} from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { isAbortError } from "@/lib/errors"
import type { ChannelRow, CategoryRow } from "@/lib/community-db/schema"
import { UNCATEGORIZED_CATEGORY_ID, type ChannelType } from "@alook/shared"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { runCommunityWsProjectionTransaction } from "@/hooks/community/community-ws/projection-transaction"
import { projectChannelScopeEviction } from "@/hooks/community/community-ws/channel-scope-projection"

// Prefix marks an optimistic row so every consumer can tell it from a real
// `ch_…` id without a separate flag, and guarantees it never collides with one.
const tempChannelId = () => `tmp_ch_${nanoid()}`

// A create can name the uncategorized target three ways: `null`, `""` (the
// sidebar's fallback when no synthetic bucket exists yet), or the synthetic
// bucket id itself (once one does). All mean "top level".
const isUncategorizedTarget = (categoryId: string | null) =>
  !categoryId || categoryId === UNCATEGORIZED_CATEGORY_ID

function invalidateChannelRefDirectory(queryClient: ReturnType<typeof useQueryClient>, args: CommunityCommandArgs<object>) {
  void queryClient.invalidateQueries({
    queryKey: communityKeys.channelRefDirectory(),
    exact: true, predicate: (query) => args.resources.includes(query),
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
export type CreateChannelResult = { channel: { id: string; name?: string; position?: number } }

async function persistTreeChange<T>(
  origin: ReturnType<typeof useCommunityMutationOrigin>,
  queryClient: ReturnType<typeof useQueryClient>,
  args: CommunityCommandArgs<{ serverId: string }>,
  optimistic: (registry: NonNullable<typeof origin.registry>) => void,
  persist: (proof: CommunityFreshQueryProof, options: ReturnType<typeof communityRequestOptions>) => Promise<T>,
): Promise<T> {
  const original = args.original, registry = origin.registry
  origin.assert(original)
  const serverId = args.serverId
  await registry?.ready
  origin.assert(original)
  await registry!.preload()
  origin.assert(original)
  await Promise.all([
    queryClient.cancelQueries({ queryKey: communityKeys.server(serverId), exact: true, predicate: (query) => args.resources.includes(query) }),
    queryClient.cancelQueries({ queryKey: communityKeys.channelRefDirectory(), exact: true, predicate: (query) => args.resources.includes(query) }),
  ])
  origin.assert(original)
  const token = beginCommunityCommandRevision(queryClient, original)
  let result!: T
  const transaction = registry!.dbClient.createTransaction({ mutationFn: async () => {
    try {
      result = await persist({ token, signal: undefined }, communityRequestOptions(queryClient, token, undefined, () => origin.assert(original)))
    } catch (error) { origin.assert(original); throw error }
  } })
  transaction.mutate(() => optimistic(registry!))
  try { await transaction.isPersisted.promise } catch (error) { origin.assert(original); throw error }
  return result
}

function settleTree(origin: ReturnType<typeof useCommunityMutationOrigin>, queryClient: ReturnType<typeof useQueryClient>, args: CommunityCommandArgs<{ serverId: string }>, error: unknown) {
  if (isAbortError(error) || !origin.registry?.runtime.lifecycle.get().active) return
  void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId), exact: true, predicate: (query) => args.resources.includes(query) })
  invalidateChannelRefDirectory(queryClient, args)
}

export function useCreateChannel() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<CreateChannelResult, Error, CreateChannelArgs>(origin, { meta: { observabilityAction: "channel.create" },
    scope: { id: "community-tree-commands" },
    mutationFn: async (args) => {
      const id = tempChannelId()
      const categoryId = isUncategorizedTarget(args.categoryId) ? null : args.categoryId
      let pending!: ChannelRow
      return persistTreeChange(origin, queryClient, args, (db) => {
        const rows = [...db.collections.channels.values()].filter((row) => row.serverId === args.serverId && row.categoryId === categoryId)
        const position = Math.max(-1, ...rows.map((row) => row.position)) + 1
        pending = { id, serverId: args.serverId, categoryId, name: args.name.trim(), type: args.type,
          parentChannelId: null, parentMessageId: null, creatorId: db.accountId,
          position, archived: false, muted: false, unread: false, tags: [], pending: true, lastMessageAt: null }
        db.collections.channels.insert(pending)
      }, async (proof, options) => {
        const result = await apiFetch<CreateChannelResult>("/api/community/channels", { method: "POST", body: JSON.stringify({ type: args.type, serverId: args.serverId, categoryId, name: args.name }), ...options })
        origin.assert(proof.token)
        publishCommunityCreatedChannel(queryClient, { ...pending, id: result.channel.id, name: result.channel.name ?? pending.name, position: result.channel.position ?? pending.position, pending: false }, proof)
        return result
      })
    },
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
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

export function useRenameChannel() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  return useCommunityCommandMutation<RenameChannelResult, Error, RenameChannelArgs>(origin, { meta: { observabilityAction: "channel.rename" },
    scope: { id: "community-tree-commands" },
    mutationFn: async (args) => {
      const original = args.original
      origin.assert(original)
      const registry = origin.registry
      await registry?.ready
      origin.assert(original)
      await Promise.all([
        queryClient.cancelQueries({ queryKey: communityKeys.server(args.serverId), exact: true, predicate: (query) => args.resources.includes(query) }),
        queryClient.cancelQueries({ queryKey: communityKeys.channelRefDirectory(), exact: true, predicate: (query) => args.resources.includes(query) }),
      ])
      origin.assert(original)
      const token = beginCommunityCommandRevision(queryClient, original)
      const persist = async () => {
        try {
          const result = await apiFetch<RenameChannelResult>(`/api/community/channels/${args.channelId}`, {
            method: "PATCH",
            body: JSON.stringify({ name: args.name }),
            ...communityRequestOptions(queryClient, token, undefined, () => origin.assert(original)),
          })
          origin.assert(original)
          publishCommunityChannelPatch(queryClient, args.channelId, (row) => ({ ...row, name: result.name }), { token, signal: undefined })
          return result
        } catch (error) {
          origin.assert(original)
          throw error
        }
      }
      if (!registry!.collections.channels.has(args.channelId)) return persist()
      let result: RenameChannelResult | undefined
      const transaction = registry!.dbClient.createTransaction({ mutationFn: async () => { result = await persist() } })
      transaction.mutate(() => registry!.collections.channels.update(args.channelId, (row) => { row.name = args.name.trim() }))
      if (transaction.mutations.length === 0) return persist()
      try {
        await transaction.isPersisted.promise
      } catch (error) {
        origin.assert(original)
        throw error
      }
      return result!
    },
    onSettled: (_data, error, args) => {
      if (isAbortError(error) || !origin.registry?.runtime.lifecycle.get().active) return
      void queryClient.invalidateQueries({ queryKey: communityKeys.server(args.serverId), exact: true, predicate: (query) => args.resources.includes(query) })
      invalidateChannelRefDirectory(queryClient, args)
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
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, MoveChannelArgs>(origin, { meta: { observabilityAction: "channel.move" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      if (db.collections.channels.has(args.channelId)) db.collections.channels.update(args.channelId, (row) => { row.categoryId = args.categoryId })
    }, async (proof, options) => {
      await apiFetch(`/api/community/channels/${args.channelId}`, { method: "PATCH", body: JSON.stringify({ categoryId: args.categoryId }), ...options })
      origin.assert(proof.token)
      publishCommunityChannelFields(queryClient, args.channelId, { categoryId: args.categoryId }, proof)
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

export type DeleteChannelArgs = { serverId: string; channelId: string }

export function useDeleteChannel() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, DeleteChannelArgs>(origin, { meta: { observabilityAction: "channel.delete" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      if (db.collections.channels.has(args.channelId)) db.collections.channels.delete(args.channelId)
    }, async (proof, options) => {
      await apiFetch(`/api/community/channels/${args.channelId}`, { method: "DELETE", ...options })
      origin.assert(proof.token)
      getActiveAccountUnreadProjection(queryClient).retireAccessScope({ kind: "channel", channelId: args.channelId })
      runCommunityWsProjectionTransaction(queryClient, (projection) => projectChannelScopeEviction(projection, queryClient, args.serverId, args.channelId))
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

// ── Categories ────────────────────────────────────────────────────────────

export type CreateCategoryArgs = {
  serverId: string
  name: string
  private?: boolean
}
export type CreateCategoryResult = { category: { id: string; name?: string; position?: number; private?: boolean } }

const tempCategoryId = () => `tmp_cat_${nanoid()}`

export function useCreateCategory() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<CreateCategoryResult, Error, CreateCategoryArgs>(origin, { meta: { observabilityAction: "category.create" },
    scope: { id: "community-tree-commands" },
    mutationFn: async (args) => {
      const id = tempCategoryId()
      let pending!: CategoryRow
      return persistTreeChange(origin, queryClient, args, (db) => {
        const rows = [...db.collections.categories.values()].filter((row) => row.serverId === args.serverId)
        const position = Math.max(-1, ...rows.map((row) => row.position)) + 1
        pending = { id, serverId: args.serverId, name: args.name.trim(), position, private: args.private === true, creatorId: db.accountId, pending: true }
        db.collections.categories.insert(pending)
      }, async (proof, options) => {
        const result = await apiFetch<CreateCategoryResult>(`/api/community/servers/${args.serverId}/categories`, { method: "POST", body: JSON.stringify({ name: args.name, private: args.private }), ...options })
        origin.assert(proof.token)
        publishCommunityCreatedCategory(queryClient, { ...pending, id: result.category.id, name: result.category.name ?? pending.name, position: result.category.position ?? pending.position, private: result.category.private ?? pending.private, pending: false }, proof)
        return result
      })
    },
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

// Category privacy is immutable after creation, so this only renames.
export type UpdateCategoryArgs = {
  serverId: string
  categoryId: string
  name?: string
}

export function useUpdateCategory() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, UpdateCategoryArgs>(origin, { meta: { observabilityAction: "category.update" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      if (args.name !== undefined && db.collections.categories.has(args.categoryId)) db.collections.categories.update(args.categoryId, (row) => { row.name = args.name!.trim() })
    }, async (proof, options) => {
      const result = await apiFetch<{ name?: string }>(`/api/community/servers/${args.serverId}/categories/${args.categoryId}`, { method: "PATCH", body: JSON.stringify({ name: args.name }), ...options })
      origin.assert(proof.token)
      if (args.name !== undefined) publishCommunityCategoryFields(queryClient, args.categoryId, { name: result?.name ?? args.name.trim() }, proof)
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

export type DeleteCategoryArgs = { serverId: string; categoryId: string }

export function useDeleteCategory() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, DeleteCategoryArgs>(origin, { meta: { observabilityAction: "category.delete" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      if (db.collections.categories.has(args.categoryId)) db.collections.categories.delete(args.categoryId)
    }, async (proof, options) => {
      await apiFetch(`/api/community/servers/${args.serverId}/categories/${args.categoryId}`, { method: "DELETE", ...options })
      origin.assert(proof.token)
      publishCommunityDeletedCategory(queryClient, args.categoryId, proof)
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

export type ReorderCategoriesArgs = { serverId: string; categoryIds: string[] }

export function useReorderCategories() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, ReorderCategoriesArgs>(origin, { meta: { observabilityAction: "category.reorder" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      args.categoryIds.forEach((id, position) => { if (db.collections.categories.get(id)?.serverId === args.serverId) db.collections.categories.update(id, (row) => { row.position = position }) })
    }, async (proof, options) => {
      await apiFetch(`/api/community/servers/${args.serverId}/categories/reorder`, { method: "PATCH", body: JSON.stringify({ categoryIds: args.categoryIds }), ...options })
      origin.assert(proof.token)
      args.categoryIds.forEach((id, position) => publishCommunityCategoryFields(queryClient, id, { position }, proof))
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}

export type ReorderChannelsArgs = { serverId: string; channelIds: string[] }

export function useReorderChannels() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  return useCommunityCommandMutation<void, Error, ReorderChannelsArgs>(origin, { meta: { observabilityAction: "channel.reorder" },
    scope: { id: "community-tree-commands" },
    mutationFn: (args) => persistTreeChange(origin, queryClient, args, (db) => {
      args.channelIds.forEach((id, position) => { if (db.collections.channels.get(id)?.serverId === args.serverId) db.collections.channels.update(id, (row) => { row.position = position }) })
    }, async (proof, options) => {
      await apiFetch(`/api/community/servers/${args.serverId}/channels/reorder`, { method: "PATCH", body: JSON.stringify({ channelIds: args.channelIds }), ...options })
      origin.assert(proof.token)
      args.channelIds.forEach((id, position) => publishCommunityChannelFields(queryClient, id, { position }, proof))
    }),
    onSettled: (_data, error, args) => settleTree(origin, queryClient, args, error),
  })
}
