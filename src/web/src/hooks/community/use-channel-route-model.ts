"use client"

import { useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"
import { useCommunityStore, useCurrentChannelMeta } from "@/stores/community"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { isDefinitiveChildMetaFailure } from "@/components/community/eject-server"
import { clearLastChannel, getLastChannel } from "@/lib/community/last-channel"
import { communityWsSubscribe, communityWsUnsubscribe } from "./use-community-ws"

type Server = ReturnType<typeof useServer>["server"]
type ChannelMeta = ReturnType<typeof useCurrentChannelMeta>

export function buildChannelRouteModel(server: Server, currentChannelMeta: ChannelMeta, channelId: string) {
  const channels = server?.categories?.flatMap((category) => category.channels) ?? []
  const channel = channels.find((candidate) => candidate.id === channelId) ?? null
  const parent = currentChannelMeta?.parentChannelId
    ? channels.find((candidate) => candidate.id === currentChannelMeta.parentChannelId) ?? null
    : null
  const isChild = !channel && !!server?.categories
  return {
    server,
    channel,
    parent,
    currentChannelMeta,
    isForum: isForumType(channel?.type),
    isChild,
    isForumPostChild: isChild && isForumType(parent?.type),
    isNotifyUnit: isChild,
    hydrated: !!server?.categories && (!isChild || currentChannelMeta !== null),
  }
}

export function useChannelRouteModel(serverId: string, serverParam: string, channelId: string) {
  const router = useRouter()
  const { server } = useServer(serverId)
  const currentChannelMeta = useCurrentChannelMeta()
  const model = useMemo(
    () => buildChannelRouteModel(server, currentChannelMeta, channelId),
    [channelId, currentChannelMeta, server],
  )
  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(channelId)
    return () => { useCommunityStore.getState().setCurrentChannelId(null) }
  }, [channelId])
  useEffect(() => {
    communityWsSubscribe({ channelId })
    if (!model.isChild) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
      return () => communityWsUnsubscribe()
    }
    apiFetch<{ name: string; parentChannelId: string | null; parentMessageId: string | null; creatorId: string | null }>(`/api/community/channels/${channelId}`)
      .then((data) => useCommunityStore.getState().setCurrentChannelMeta(data))
      .catch((error) => {
        useCommunityStore.getState().setCurrentChannelMeta(null)
        if (isDefinitiveChildMetaFailure(error)) {
          if (getLastChannel(serverId) === channelId) clearLastChannel(serverId)
          router.replace(`/c/channels/${serverParam}`)
        } else {
          toastApiError(error, "Failed to load thread")
        }
      })
    return () => communityWsUnsubscribe()
  }, [channelId, model.isChild, router, serverId, serverParam])
  return model
}
