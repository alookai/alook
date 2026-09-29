import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { useCommunityWsStore } from "@/stores/community/ws"
import type { ChannelRow } from "./schema"

export type ChannelMetadata = {
  id: string
  serverId: string
  name: string
  type: string
  parentChannelId: string | null
  parentMessageId: string | null
  creatorId: string | null
  archived: boolean | number
  lastMessageAt: string | null
  createdAt: string
}

export type ChannelMetadataResource = {
  metadata: ChannelMetadata & {
    archived: boolean
    activityAt: string
    verifiedEpoch: number
  }
  channels: ChannelRow[]
}

export function channelMetadataResourceKey(
  accountId: string,
  serverId: string,
  channelId: string,
) {
  return [
    "community",
    "db",
    accountId,
    "channel-resource",
    "metadata",
    serverId,
    channelId,
  ] as const
}

export function serverIdFromChannelMetadataResourceKey(
  queryKey: readonly unknown[],
): string | null {
  if (
    queryKey.length !== 7
    || queryKey[0] !== "community"
    || queryKey[1] !== "db"
    || typeof queryKey[2] !== "string"
    || queryKey[3] !== "channel-resource"
    || queryKey[4] !== "metadata"
    || typeof queryKey[5] !== "string"
    || typeof queryKey[6] !== "string"
  ) return null
  return queryKey[5]
}

export function isChannelMetadataResourceQueryKey(
  queryKey: readonly unknown[],
  serverId?: string,
) {
  const candidate = serverIdFromChannelMetadataResourceKey(queryKey)
  return candidate !== null && (serverId === undefined || candidate === serverId)
}

function currentChannelRow(queryClient: QueryClient, channelId: string) {
  for (const query of queryClient.getQueryCache().getAll()) {
    const data = query.state.data as { channels?: ChannelRow[] } | undefined
    const row = data?.channels?.find((channel) => channel.id === channelId)
    if (row) return row
  }
  return undefined
}

export function createChannelMetadataResourceQueryFn(
  queryClient: QueryClient,
  accountId: string,
) {
  return async ({ queryKey, signal }: QueryFunctionContext): Promise<ChannelMetadataResource> => {
    const expectedKeyPrefix = ["community", "db", accountId, "channel-resource", "metadata"]
    const serverId = queryKey[expectedKeyPrefix.length]
    const channelId = queryKey[expectedKeyPrefix.length + 1]
    if (
      queryKey.length !== expectedKeyPrefix.length + 2
      || !expectedKeyPrefix.every((part, index) => queryKey[index] === part)
      || typeof serverId !== "string"
      || typeof channelId !== "string"
    ) throw new Error("invalid channel metadata resource key")

    const before = useCommunityWsStore.getState()
    const accessEpoch = before.accessEpoch
    const generation = before.channelAccessScopes.get(channelId)?.generation ?? 0
    const metadata = await apiFetch<ChannelMetadata>(
      `/api/community/channels/${channelId}`,
      { signal },
    )
    const after = useCommunityWsStore.getState()
    if (
      signal.aborted
      || after.profileViewerId !== before.profileViewerId
      || after.profileAccountEpoch !== before.profileAccountEpoch
      || after.accessEpoch !== accessEpoch
      || (after.channelAccessScopes.get(channelId)?.generation ?? 0) !== generation
    ) throw new DOMException("Stale channel metadata", "AbortError")
    if (
      metadata.id !== channelId
      || metadata.serverId !== serverId
      || !["text", "forum", "thread"].includes(metadata.type)
    ) throw new Error("Channel metadata scope mismatch")

    after.grantServerAccess(serverId)
    after.rememberChannelAccess(serverId, channelId, metadata.parentChannelId)
    const existing = currentChannelRow(queryClient, channelId)
    const archived = metadata.archived === true || metadata.archived === 1
    return {
      metadata: {
        ...metadata,
        archived,
        activityAt: metadata.lastMessageAt ?? metadata.createdAt,
        verifiedEpoch: accessEpoch,
      },
      channels: [{
        id: metadata.id,
        serverId: metadata.serverId,
        categoryId: existing?.categoryId ?? null,
        name: metadata.name,
        type: metadata.type as ChannelRow["type"],
        parentChannelId: metadata.parentChannelId,
        parentMessageId: metadata.parentMessageId,
        creatorId: metadata.creatorId,
        position: existing?.position ?? 0,
        archived,
        muted: existing?.muted ?? false,
        unread: existing?.unread ?? false,
        ...(existing?.baseUnread === undefined ? {} : { baseUnread: existing.baseUnread }),
        tags: existing?.tags ?? [],
        pending: false,
        lastMessageAt: metadata.lastMessageAt,
        ...(existing?.openerSeq === undefined ? {} : { openerSeq: existing.openerSeq }),
        ...(existing?.openerUnread === undefined ? {} : { openerUnread: existing.openerUnread }),
      }],
    }
  }
}
