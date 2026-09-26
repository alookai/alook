"use client"

import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { fetchChannelMetadata, type ChannelMetadata } from "@/hooks/community/channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import type { ChildChannelMeta } from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"
import { ApiError } from "@/lib/errors"
import {
  useOptionalCommunityDbRegistry,
  useRouteChannelProjection,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityChannelMetadata,
} from "@/lib/community-db/sync"

function projectChildMeta(payload: ChannelMetadata, verifiedEpoch: number): ChildChannelMeta {
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
    archived: payload.archived === true || payload.archived === 1,
    activityAt: payload.lastMessageAt ?? payload.createdAt,
    verifiedEpoch,
  }
}

function sameChildChannelMeta(left: ChildChannelMeta, right: ChildChannelMeta): boolean {
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
  const dbChannel = useRouteChannelProjection(channelId)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
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
  const query = useQuery<ChildChannelMeta>({
    queryKey: communityKeys.channelMeta(serverId, channelId),
    queryFn: async ({ signal }) => {
      const token = captureCommunityLiveSnapshotToken(queryClient)
      const meta = await fetchChannelMetadata(serverId, channelId, signal)
      publishCommunityChannelMetadata(queryClient, {
        metadata: meta,
        proof: { token, signal },
      })
      return projectChildMeta(meta, meta.verifiedEpoch)
    },
    enabled,
    placeholderData: registry ? undefined : placeholderData,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && [401, 403, 404].includes(error.status))
      && failureCount < 1,
  })
  const [trusted, setTrusted] = useState<{
    channelId: string
    meta: ChildChannelMeta
  } | null>(null)
  useEffect(() => {
    if (registry) return
    if (query.data?.verifiedEpoch !== accessEpoch) return
    setTrusted((current) => {
      if (query.data!.archived) return current === null ? current : null
      if (
        current?.channelId === channelId &&
        sameChildChannelMeta(current.meta, query.data!)
      ) return current
      return { channelId, meta: query.data! }
    })
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
