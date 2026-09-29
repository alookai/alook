import { parseLoadSubsetOptions } from "@tanstack/query-db-collection"
import type { LoadSubsetOptions } from "@tanstack/react-db"
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { UNCATEGORIZED_CATEGORY_ID } from "@alook/shared"
import { apiFetch } from "@/lib/api/client"
import type { Category, Channel } from "@/lib/community/models/navigation"
import { ApiError } from "@/lib/errors"
import { evictServerChannelScopes } from "@/hooks/community/community-ws/scope-eviction"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadScope,
} from "@/hooks/community/account-unread-projection"
import type { CategoryRow, ChannelRow } from "./schema"
import {
  emptyChannelResourceEnvelope,
  type ChannelResourceEnvelope,
} from "./channel-resource-envelope"

export type ServerDetailResource = ChannelResourceEnvelope & {
  serverId: string
}

type RawChannel = Channel & { categoryId: string | null }

export function serverDetailResourceBaseKey(accountId: string) {
  return ["community", "db", accountId, "channel-resource"] as const
}

export function serverDetailResourceKey(accountId: string, serverId: string) {
  return [...serverDetailResourceBaseKey(accountId), "server", serverId] as const
}

export function serverIdFromServerDetailResourceKey(
  queryKey: readonly unknown[],
) {
  return queryKey.length === 6
    && queryKey[0] === "community"
    && queryKey[1] === "db"
    && typeof queryKey[2] === "string"
    && queryKey[3] === "channel-resource"
    && queryKey[4] === "server"
    && typeof queryKey[5] === "string"
      ? queryKey[5]
      : null
}

export function isServerDetailResourceQueryKey(
  queryKey: readonly unknown[],
  serverId?: string,
) {
  const candidate = serverIdFromServerDetailResourceKey(queryKey)
  return candidate !== null && (serverId === undefined || candidate === serverId)
}

function serverIdFromSubset(options: LoadSubsetOptions) {
  const filters = parseLoadSubsetOptions(options).filters
  const serverIds = filters.flatMap((filter) => (
    filter.operator === "eq"
    && filter.field.at(-1) === "serverId"
    && typeof filter.value === "string"
      ? [filter.value]
      : []
  ))
  return new Set(serverIds).size === 1 ? serverIds[0] : null
}

export function serverDetailResourceQueryKey(
  accountId: string,
  options: LoadSubsetOptions = {},
) {
  const base = serverDetailResourceBaseKey(accountId)
  const serverId = serverIdFromSubset(options)
  return serverId ? serverDetailResourceKey(accountId, serverId) : base
}

function normalizeServerDetailResource(
  serverId: string,
  categoryData: {
    categories: Array<Omit<Category, "channels"> & { serverId?: string }>
  },
  channelData: { channels: RawChannel[] },
): ServerDetailResource {
  const categories: CategoryRow[] = categoryData.categories.flatMap((category, position) => (
    category.id === UNCATEGORIZED_CATEGORY_ID ? [] : [{
      id: category.id,
      serverId,
      name: category.name,
      position,
      private: category.private === true || category.private === 1,
      creatorId: category.creatorId ?? null,
      pending: category.pending === true,
    }]
  ))
  const positionByCategory = new Map<string | null, number>()
  const channels: ChannelRow[] = channelData.channels.map((channel) => {
    const position = positionByCategory.get(channel.categoryId) ?? 0
    positionByCategory.set(channel.categoryId, position + 1)
    return {
      id: channel.id,
      serverId,
      categoryId: channel.categoryId,
      name: channel.name,
      type: channel.type ?? "text",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: channel.creatorId ?? null,
      position,
      archived: false,
      muted: channel.muted === true,
      unread: false,
      ...(channel.type === "forum" ? { baseUnread: false } : {}),
      tags: channel.tags ?? [],
      pending: channel.pending === true,
      lastMessageAt: null,
    }
  })
  return {
    ...emptyChannelResourceEnvelope(),
    serverId,
    categories,
    channels,
  }
}

export function createServerDetailResourceQueryFn(
  queryClient: QueryClient,
  accountId: string,
) {
  return async ({ queryKey, signal }: QueryFunctionContext): Promise<ServerDetailResource> => {
    const base = serverDetailResourceBaseKey(accountId)
    const serverId = queryKey[base.length + 1]
    if (
      queryKey.length !== base.length + 2
      || !base.every((segment, index) => segment === queryKey[index])
      || queryKey[base.length] !== "server"
      || typeof serverId !== "string"
    ) {
      return {
        ...emptyChannelResourceEnvelope(),
        serverId: "",
      }
    }
    const projection = getActiveAccountUnreadProjection(queryClient)
    const family = `server-detail:${serverId}` as const
    const token = projection.beginSnapshot(family, "channels")
    try {
      const [categoryData, channelData] = await Promise.all([
        apiFetch<{ categories: Array<Omit<Category, "channels"> & { serverId?: string }> }>(
          `/api/community/servers/${serverId}/categories`,
          { signal },
        ),
        apiFetch<{ channels: RawChannel[] }>(
          `/api/community/servers/${serverId}/channels`,
          { signal },
        ),
      ])
      const resource = normalizeServerDetailResource(serverId, categoryData, channelData)
      const confirmedAccessScopes: AccountUnreadScope[] = [
        { kind: "server", serverId },
        ...resource.channels.map((channel) => ({
          kind: "channel" as const,
          channelId: channel.id,
        })),
      ]
      projection.absorbSnapshot(token, [], { confirmedAccessScopes })
      return resource
    } catch (error) {
      projection.cancelSnapshot(token)
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        evictServerChannelScopes(queryClient, serverId)
      }
      throw error
    }
  }
}

export function selectServerDetailCategories(resource: ServerDetailResource | undefined) {
  return resource?.categories ?? []
}

export function selectServerDetailChannels(resource: ServerDetailResource | undefined) {
  return resource?.channels ?? []
}

export function serverDetailResourceChannelIds(resource: ServerDetailResource) {
  const categoryPosition = new Map(
    resource.categories.map((category) => [category.id, category.position]),
  )
  return resource.channels
    .filter((channel) => channel.type !== "thread" && !channel.pending)
    .slice()
    .sort((left, right) => (
      (left.categoryId == null
        ? Number.MAX_SAFE_INTEGER
        : categoryPosition.get(left.categoryId) ?? Number.MAX_SAFE_INTEGER)
      - (right.categoryId == null
        ? Number.MAX_SAFE_INTEGER
        : categoryPosition.get(right.categoryId) ?? Number.MAX_SAFE_INTEGER)
      || left.position - right.position
      || left.id.localeCompare(right.id)
    ))
    .map((channel) => channel.id)
}
