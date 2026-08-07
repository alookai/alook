"use client"

import { useEffect, useMemo, useState } from "react"
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
  const channelMeta = !isChild || metaState?.channelId === channelId ? currentChannelMeta : null
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
  const { server } = useServer(serverId)
  const currentChannelMeta = useCurrentChannelMeta()
  const [metaState, setMetaState] = useState<{ channelId: string; settled: boolean } | null>(null)
  const model = useMemo(
    () => buildChannelRouteModel(server, currentChannelMeta, channelId, metaState),
    [channelId, currentChannelMeta, metaState, server],
  )
  useEffect(() => {
    useCommunityStore.getState().setCurrentChannelId(channelId)
    return () => { useCommunityStore.getState().setCurrentChannelId(null) }
  }, [channelId])
  useEffect(() => {
    communityWsSubscribe({ channelId })
    if (!model.isChild) {
      setMetaState({ channelId, settled: true })
      useCommunityStore.getState().setCurrentChannelMeta(null)
      return () => communityWsUnsubscribe()
    }
    setMetaState({ channelId, settled: false })
    let active = true
    apiFetch<{ name: string; parentChannelId: string | null; parentMessageId: string | null; creatorId: string | null }>(`/api/community/channels/${channelId}`)
      .then((data) => {
        if (!active) return
        useCommunityStore.getState().setCurrentChannelMeta(data)
        setMetaState({ channelId, settled: true })
      })
      .catch((error) => {
        if (!active) return
        useCommunityStore.getState().setCurrentChannelMeta(null)
        if (isDefinitiveChildMetaFailure(error)) {
          if (getLastChannel(serverId) === channelId) clearLastChannel(serverId)
          router.replace(`/c/channels/${serverParam}`)
        } else {
          toastApiError(error, "Failed to load thread")
        }
      })
    return () => {
      active = false
      communityWsUnsubscribe()
    }
  }, [channelId, model.isChild, router, serverId, serverParam])
  return model
}
