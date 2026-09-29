import { parseLoadSubsetOptions } from "@tanstack/query-db-collection"
import type { AccountAttentionSnapshot } from "@alook/shared"
import type { LoadSubsetOptions } from "@tanstack/react-db"
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import type { DM } from "@/lib/community/models/people"
import { getActiveAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { useCommunityWsStore } from "@/stores/community/ws"
import { communityKeys } from "@/lib/query-keys"
import {
  channelMembershipKey,
  type ChannelMembershipRow,
  type ChannelRow,
  type ProfileRow,
} from "./schema"
import {
  emptyChannelResourceEnvelope,
  type ChannelResourceEnvelope,
} from "./channel-resource-envelope"
import {
  channelMetadataResourceKey,
  createChannelMetadataResourceQueryFn,
  type ChannelMetadataResource,
} from "./channel-metadata-resource"
import {
  createServerDetailResourceQueryFn,
  serverDetailResourceKey,
  type ServerDetailResource,
} from "./server-detail-resource"

export type DmsResource = ChannelResourceEnvelope

type ChannelResource = DmsResource | ServerDetailResource | ChannelMetadataResource

export function dmsResourceKey(accountId: string) {
  return ["community", "db", accountId, "channel-resource"] as const
}

export function isDmsResourceQueryKey(queryKey: readonly unknown[]) {
  return queryKey.length === 4
    && queryKey[0] === "community"
    && queryKey[1] === "db"
    && typeof queryKey[2] === "string"
    && queryKey[3] === "channel-resource"
}

function equalityValue(options: LoadSubsetOptions, field: string) {
  const values = parseLoadSubsetOptions(options).filters.flatMap((filter) => (
    filter.operator === "eq"
    && filter.field.at(-1) === field
    && typeof filter.value === "string"
      ? [filter.value]
      : []
  ))
  return new Set(values).size === 1 ? values[0] : null
}

export function channelResourceQueryKey(
  accountId: string,
  options: LoadSubsetOptions = {},
) {
  const serverId = equalityValue(options, "serverId")
  const channelId = equalityValue(options, "id")
  if (serverId && channelId) return channelMetadataResourceKey(accountId, serverId, channelId)
  return serverId ? serverDetailResourceKey(accountId, serverId) : dmsResourceKey(accountId)
}

function normalizeDmsResource(
  accountId: string,
  response: { conversations: DM[] },
): DmsResource {
  const channels: ChannelRow[] = []
  const channelMemberships: ChannelMembershipRow[] = []
  const profiles = new Map<string, ProfileRow>()
  for (const [position, dm] of response.conversations.entries()) {
    channels.push({
      id: dm.id,
      serverId: null,
      categoryId: null,
      name: "",
      type: "dm",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      position,
      archived: false,
      muted: false,
      unread: false,
      tags: [],
      pending: false,
      lastMessageAt: dm.activityAt ?? null,
      preview: dm.preview,
      ...(dm.lastUnreadSeq === undefined ? {} : { lastUnreadSeq: dm.lastUnreadSeq }),
    })
    channelMemberships.push(
      {
        id: channelMembershipKey(dm.id, accountId, "access"),
        channelId: dm.id,
        userId: accountId,
        relation: "access",
      },
      {
        id: channelMembershipKey(dm.id, dm.userId, "access"),
        channelId: dm.id,
        userId: dm.userId,
        relation: "access",
      },
    )
    profiles.set(dm.userId, {
      userId: dm.userId,
      name: dm.name,
      discriminator: dm.discriminator,
      avatar: dm.avatar,
      avatarVersion: dm.avatarVersion,
    })
  }
  return {
    ...emptyChannelResourceEnvelope(),
    conversations: response.conversations,
    channels,
    channelMemberships,
    profiles: [...profiles.values()],
  }
}

export function mergeAccountAttentionIncludedOwners(
  accountId: string,
  resource: DmsResource,
  included: AccountAttentionSnapshot["included"] | undefined,
): DmsResource {
  if (!included) return resource

  const channels = new Map(resource.channels.map((row) => [row.id, row]))
  const memberships = new Map(resource.channelMemberships.map((row) => [row.id, row]))
  const profiles = new Map(resource.profiles.map((row) => [row.userId, row]))
  for (const channel of included.channels) {
    const existing = channels.get(channel.id)
    channels.set(channel.id, {
      id: channel.id,
      serverId: channel.serverId,
      categoryId: existing?.categoryId ?? null,
      name: channel.name,
      type: channel.type,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      creatorId: channel.creatorId,
      position: existing?.position ?? 0,
      archived: channel.archived,
      muted: existing?.muted ?? false,
      unread: existing?.unread ?? false,
      ...(existing?.baseUnread === undefined ? {} : { baseUnread: existing.baseUnread }),
      tags: existing?.tags ?? [],
      pending: false,
      lastMessageAt: channel.lastMessageAt,
      ...(channel.openerSeq === undefined ? {} : { openerSeq: channel.openerSeq }),
      ...(channel.openerUnread === undefined ? {} : { openerUnread: channel.openerUnread }),
    })
    const membership = {
      id: channelMembershipKey(channel.id, accountId, "access"),
      channelId: channel.id,
      userId: accountId,
      relation: "access" as const,
      source: "inherited" as const,
    }
    memberships.set(membership.id, membership)
  }
  for (const [position, dm] of included.dms.entries()) {
    const existing = channels.get(dm.id)
    channels.set(dm.id, {
      id: dm.id,
      serverId: null,
      categoryId: null,
      name: "",
      type: "dm",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      position: existing?.position ?? position,
      archived: false,
      muted: existing?.muted ?? false,
      unread: true,
      tags: [],
      pending: false,
      lastMessageAt: dm.lastMessageAt,
      preview: existing?.preview ?? "",
      lastUnreadSeq: dm.lastUnreadSeq,
    })
    for (const userId of [accountId, dm.userId]) {
      const membership = {
        id: channelMembershipKey(dm.id, userId, "access"),
        channelId: dm.id,
        userId,
        relation: "access" as const,
      }
      memberships.set(membership.id, membership)
    }
  }
  for (const profile of included.profiles) {
    profiles.set(profile.userId, { ...profiles.get(profile.userId), ...profile })
  }
  return {
    ...resource,
    channels: [...channels.values()],
    channelMemberships: [...memberships.values()],
    profiles: [...profiles.values()],
  }
}

export function createDmsResourceQueryFn(
  queryClient: QueryClient,
  accountId: string,
  options?: { routeVerification?: boolean },
) {
  return async ({ signal }: QueryFunctionContext): Promise<DmsResource> => {
    const projection = getActiveAccountUnreadProjection(queryClient)
    const token = projection.beginSnapshot("dms", "dms")
    const before = useCommunityWsStore.getState()
    const profileViewerId = before.profileViewerId
    const profileAccountEpoch = before.profileAccountEpoch
    const accessEpoch = before.accessEpoch
    try {
      const response = await apiFetch<{ conversations: DM[] }>(
        "/api/community/users/me/dms",
        signal || options?.routeVerification
          ? {
              signal,
              ...(options?.routeVerification
                ? { headers: { "X-Alook-DM-Route-Verification": "1" } }
                : {}),
            }
          : undefined,
      )
      const attention = queryClient.getQueryData<AccountAttentionSnapshot>(
        communityKeys.accountAttention(),
      )
      const after = useCommunityWsStore.getState()
      if (
        signal?.aborted
        || after.profileViewerId !== profileViewerId
        || after.profileAccountEpoch !== profileAccountEpoch
        || after.accessEpoch !== accessEpoch
      ) throw new DOMException("Stale DM resource", "AbortError")
      const resource = mergeAccountAttentionIncludedOwners(
        accountId,
        normalizeDmsResource(accountId, response),
        attention?.included,
      )
      projection.absorbSnapshot(
        token,
        response.conversations.flatMap((dm) => (
          dm.lastUnreadSeq === undefined
            ? []
            : [{ channelId: dm.id, lastUnreadSeq: dm.lastUnreadSeq }]
        )),
        {
          confirmedAccessScopes: resource.channels.map((channel) => ({
            kind: "channel" as const,
            channelId: channel.id,
          })),
        },
      )
      return resource
    } catch (error) {
      projection.cancelSnapshot(token)
      throw error
    }
  }
}

export function createChannelResourceQueryFn(queryClient: QueryClient, accountId: string) {
  const serverQueryFn = createServerDetailResourceQueryFn(queryClient, accountId)
  const dmsQueryFn = createDmsResourceQueryFn(queryClient, accountId)
  const metadataQueryFn = createChannelMetadataResourceQueryFn(queryClient, accountId)
  const base = dmsResourceKey(accountId)
  const serverPrefix = [...base, "server"] as const
  const metadataPrefix = [...base, "metadata"] as const
  const dmsKey = dmsResourceKey(accountId)
  return (context: QueryFunctionContext): Promise<ChannelResource> => {
    if (
      context.queryKey.length === serverPrefix.length + 1
      && serverPrefix.every((part, index) => context.queryKey[index] === part)
    ) {
      return serverQueryFn(context)
    }
    if (
      context.queryKey.length === metadataPrefix.length + 2
      && metadataPrefix.every((part, index) => context.queryKey[index] === part)
    ) {
      return metadataQueryFn(context)
    }
    if (
      context.queryKey.length === dmsKey.length
      && dmsKey.every((part, index) => context.queryKey[index] === part)
    ) {
      return dmsQueryFn(context)
    }
    return Promise.resolve(emptyChannelResourceEnvelope())
  }
}

export function selectDmsChannelMemberships(resource: DmsResource | undefined) {
  return resource?.channelMemberships ?? []
}

export function selectDmsProfiles(resource: DmsResource | undefined) {
  return resource?.profiles ?? []
}
