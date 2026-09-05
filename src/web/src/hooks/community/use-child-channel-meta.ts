"use client"

import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { fetchChannelMetadata, type ChannelMetadata } from "@/hooks/community/channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import type { ChildChannelMeta } from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"

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
) {
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const query = useQuery<ChildChannelMeta>({
    queryKey: communityKeys.channelMeta(serverId, channelId),
    queryFn: async ({ signal }) => {
      const meta = await fetchChannelMetadata(serverId, channelId, signal)
      return projectChildMeta(meta, meta.verifiedEpoch)
    },
    enabled,
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  })
  const [trusted, setTrusted] = useState<{
    channelId: string
    meta: ChildChannelMeta
  } | null>(null)
  useEffect(() => {
    if (query.data?.verifiedEpoch !== accessEpoch) return
    setTrusted(query.data.archived ? null : { channelId, meta: query.data })
  }, [accessEpoch, channelId, query.data])
  const trustedMeta = trusted?.channelId === channelId ? trusted.meta : undefined
  const renderable = pickRenderableChildMeta(query.data, trustedMeta, accessEpoch)
  return {
    ...query,
    data: renderable,
    isVerified: !!renderable,
  }
}
