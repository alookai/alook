"use client"

import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type {
  ChildChannelMeta,
  ForumSidebarQueryData,
} from "@/hooks/community/use-forum-sidebar-threads"
import { useCommunityWsStore } from "@/stores/community/ws"

type ChannelMetaPayload = {
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

function projectChildMeta(payload: ChannelMetaPayload, verifiedEpoch: number): ChildChannelMeta {
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

export function isChildChannelMetaVerified(
  meta: ChildChannelMeta | undefined,
  accessEpoch: number,
  accessConnected: boolean,
) {
  return !!meta && accessConnected && meta.verifiedEpoch === accessEpoch && !meta.archived
}

export function useChildChannelMeta(
  serverId: string,
  channelId: string,
  enabled: boolean,
) {
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const accessConnected = useCommunityWsStore((state) => state.accessConnected)
  const sidebar = useQuery<ForumSidebarQueryData>({
    queryKey: communityKeys.forumSidebarThreads(serverId),
    queryFn: () => Promise.reject(new Error("forum sidebar observer only")),
    enabled: false,
  })
  const query = useQuery<ChildChannelMeta>({
    queryKey: communityKeys.channelMeta(serverId, channelId),
    queryFn: async () => {
      const requestEpoch = useCommunityWsStore.getState().accessEpoch
      return projectChildMeta(
        await apiFetch<ChannelMetaPayload>(`/api/community/channels/${channelId}`),
        requestEpoch,
      )
    },
    enabled: enabled && (
      (sidebar.isSuccess && sidebar.fetchStatus === "idle") || sidebar.isError
    ),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  })
  return {
    ...query,
    isVerified: isChildChannelMetaVerified(query.data, accessEpoch, accessConnected),
  }
}
