"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"
import { useCommunityStore, useCurrentChannelMeta } from "@/stores/community"
import { toastApiError } from "@/lib/api/client"
import { isDefinitiveChildMetaFailure } from "@/lib/community/eject-server"
import { clearLastChannel, getLastChannel } from "@/lib/community/last-channel"
import { communityWsSubscribe, communityWsUnsubscribe } from "./use-community-ws"
import { useChildChannelMeta } from "./use-child-channel-meta"
import {
  removeForumSidebarThreadExact,
  removeForumSidebarUnreadChild,
} from "./use-forum-sidebar-threads"

type Server = ReturnType<typeof useServer>["server"]
type ChannelMeta = ReturnType<typeof useCurrentChannelMeta>

export function buildChannelRouteModel(
  server: Server,
  currentChannelMeta: ChannelMeta,
  channelId: string,
  metaState: { channelId: string; settled: boolean } | null = null,
) {
  const channels = server?.categories?.flatMap((category) => category.channels) ?? []
  const channel = channels.find((candidate) => candidate.id === channelId) ?? null
  const isChild = !channel && !!server?.categories
  const metaSettled = !isChild || (metaState?.channelId === channelId && metaState.settled)
  const channelMeta = !isChild || metaSettled ? currentChannelMeta : null
  const parent = channelMeta?.parentChannelId
    ? channels.find((candidate) => candidate.id === channelMeta.parentChannelId) ?? null
    : null
  return {
    server,
    channel,
    parent,
    currentChannelMeta: channelMeta,
    isForum: isForumType(channel?.type),
    isChild,
    isForumPostChild: isChild && isForumType(parent?.type),
    isNotifyUnit: isChild,
    metaSettled,
    routeHydrated: !!server?.categories && metaSettled && (!isChild || channelMeta !== null),
  }
}

export function useChannelRouteModel(serverId: string, serverParam: string, channelId: string) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { server } = useServer(serverId)
  const currentChannelMeta = useCurrentChannelMeta()
  const topLevelChannel = server?.categories
    ?.flatMap((category) => category.channels)
    .some((candidate) => candidate.id === channelId)
  const isChild = !!server?.categories && !topLevelChannel
  const metaQuery = useChildChannelMeta(serverId, channelId, isChild)
  const model = useMemo(
    () => buildChannelRouteModel(
      server,
      currentChannelMeta,
      channelId,
      isChild
        ? { channelId, settled: metaQuery.isVerified }
        : { channelId, settled: true },
    ),
    [channelId, currentChannelMeta, isChild, metaQuery.isVerified, server],
  )
  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(channelId)
    return () => { useCommunityStore.getState().setCurrentChannelId(null) }
  }, [channelId])
  useEffect(() => {
    communityWsSubscribe({ channelId })
    return () => communityWsUnsubscribe()
  }, [channelId])
  useEffect(() => {
    if (!isChild) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
      return
    }
    if (metaQuery.data && metaQuery.isVerified) {
      useCommunityStore.getState().setCurrentChannelMeta(metaQuery.data)
    } else if (metaQuery.error || metaQuery.data?.archived) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
      if (metaQuery.data?.archived || isDefinitiveChildMetaFailure(metaQuery.error)) {
        removeForumSidebarUnreadChild(queryClient, serverId, channelId)
        removeForumSidebarThreadExact(queryClient, serverId, channelId)
        if (getLastChannel(serverId) === channelId) clearLastChannel(serverId)
        router.replace(`/c/channels/${serverParam}`)
      } else {
        toastApiError(metaQuery.error, "Failed to load thread")
      }
    }
  }, [channelId, isChild, metaQuery.data, metaQuery.error, metaQuery.isVerified, queryClient, router, serverId, serverParam])
  return model
}
