"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import type { ChildChannelMeta } from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ApiError } from "@/lib/errors"
import {
  channelMetadataResourceKey,
  createChannelMetadataResourceQueryFn,
  type ChannelMetadataResource,
} from "@/lib/community-db/channel-metadata-resource"
import {
  useOptionalCommunityDbRegistry,
  useRouteChannelProjection,
} from "@/lib/community-db/projections"

function projectChildMeta(
  payload: ChannelMetadataResource["metadata"],
): ChildChannelMeta {
  if (!payload.parentChannelId || !payload.parentMessageId) {
    throw new Error("invalid child channel metadata")
  }
  return {
    id: payload.id,
    serverId: payload.serverId,
    name: payload.name,
    type: payload.type,
    parentChannelId: payload.parentChannelId,
    parentMessageId: payload.parentMessageId,
    creatorId: payload.creatorId,
    archived: payload.archived,
    activityAt: payload.activityAt,
    verifiedEpoch: payload.verifiedEpoch,
  }
}

function childMetaPlaceholderResource(meta: ChildChannelMeta): ChannelMetadataResource {
  return {
    metadata: {
      ...meta,
      lastMessageAt: meta.activityAt || null,
      createdAt: meta.activityAt,
    },
    channels: [],
  }
}

function selectChildMeta(resource: ChannelMetadataResource) {
  return projectChildMeta(resource.metadata)
}

export function sameChildChannelMeta(left: ChildChannelMeta, right: ChildChannelMeta): boolean {
  return left.id === right.id &&
    left.serverId === right.serverId &&
    left.name === right.name &&
    left.type === right.type &&
    left.parentChannelId === right.parentChannelId &&
    left.parentMessageId === right.parentMessageId &&
    (left.creatorId ?? null) === (right.creatorId ?? null) &&
    left.archived === right.archived &&
    left.activityAt === right.activityAt &&
    left.verifiedEpoch === right.verifiedEpoch
}

type TrustedChildMeta = { channelId: string; meta: ChildChannelMeta } | null

export function updateTrustedChildMeta(
  current: TrustedChildMeta,
  channelId: string,
  data: ChildChannelMeta,
): TrustedChildMeta {
  if (data.archived) return current === null ? current : null
  if (
    current?.channelId === channelId
    && sameChildChannelMeta(current.meta, data)
  ) return current
  return { channelId, meta: data }
}

export function pickRenderableChildMeta(
  meta: ChildChannelMeta | undefined,
  trusted: ChildChannelMeta | undefined,
  accessEpoch: number,
): ChildChannelMeta | undefined {
  if (meta?.verifiedEpoch === accessEpoch) return meta.archived ? undefined : meta
  if (trusted?.id === meta?.id || !meta) return trusted?.archived ? undefined : trusted
  return undefined
}

export function useChildChannelMeta(
  serverId: string,
  channelId: string,
  enabled: boolean,
  placeholderData?: ChildChannelMeta,
) {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const dbChannel = useRouteChannelProjection(channelId, serverId)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const placeholderResource = useMemo(() => (
    registry || !placeholderData
      ? undefined
      : childMetaPlaceholderResource(placeholderData)
  ), [placeholderData, registry])
  const dbPlaceholder = dbChannel?.type === "thread"
    && dbChannel.serverId === serverId
    && dbChannel.parentChannelId
    && dbChannel.parentMessageId
    ? {
        id: dbChannel.id,
        serverId,
        name: dbChannel.name,
        type: dbChannel.type,
        parentChannelId: dbChannel.parentChannelId,
        parentMessageId: dbChannel.parentMessageId,
        creatorId: dbChannel.creatorId ?? null,
        archived: dbChannel.archived,
        activityAt: dbChannel.lastMessageAt ?? "",
        verifiedEpoch: accessEpoch,
      }
    : undefined
  const query = useQuery<ChannelMetadataResource, Error, ChildChannelMeta>({
    queryKey: channelMetadataResourceKey(
      registry?.scopeId ?? "anon",
      serverId,
      channelId,
    ),
    queryFn: createChannelMetadataResourceQueryFn(queryClient, registry?.scopeId ?? "anon"),
    select: selectChildMeta,
    enabled,
    placeholderData: placeholderResource,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && [401, 403, 404].includes(error.status))
      && failureCount < 1,
  })
  const [trusted, setTrusted] = useState<TrustedChildMeta>(null)
  useEffect(() => {
    if (registry) return
    if (query.data?.verifiedEpoch !== accessEpoch) return
    setTrusted((current) => updateTrustedChildMeta(current, channelId, query.data!))
  }, [accessEpoch, channelId, query.data, registry])
  const trustedMeta = trusted?.channelId === channelId ? trusted.meta : undefined
  const renderable = registry
    ? dbPlaceholder?.archived ? undefined : dbPlaceholder
    : pickRenderableChildMeta(query.data, trustedMeta, accessEpoch)
  return {
    ...query,
    data: renderable,
    isVerified: !!renderable,
  }
}
