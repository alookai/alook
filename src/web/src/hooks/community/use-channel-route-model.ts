"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"
import { useCommunityStore, useCurrentChannelMeta } from "@/stores/community"
import { toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { useCommunityWsStore } from "@/stores/community/ws"
import { isDefinitiveChildMetaFailure } from "@/lib/community/eject-server"
import { clearLastChannel, getLastChannel } from "@/lib/community/last-channel"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "@/lib/community/last-community-route"
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
  const currentMetaMatches = !currentChannelMeta
    || !("id" in currentChannelMeta)
    || currentChannelMeta.id === channelId
  const channelMeta = !isChild || (metaSettled && currentMetaMatches)
    ? currentChannelMeta
    : null
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

export function useChannelRouteModel(
  serverId: string,
  serverParam: string,
  channelId: string,
  accountId: string,
) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { server } = useServer(serverId)
  const currentChannelMeta = useCurrentChannelMeta()
  const topLevelChannel = server?.categories
    ?.flatMap((category) => category.channels)
    .some((candidate) => candidate.id === channelId)
  const isChild = !!server?.categories && !topLevelChannel
  const metaQuery = useChildChannelMeta(serverId, channelId, isChild)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const retryScope = JSON.stringify([accountId, serverId, channelId, accessEpoch])
  const retryAttemptRef = useRef<{ scope: string } | null>(null)
  const [retryAttempt, setRetryAttempt] = useState<{ scope: string } | null>(null)
  const retryingMetadata = retryAttempt?.scope === retryScope
  const metadataExit = isDefinitiveChildMetaFailure(metaQuery.error)
    || (metaQuery.error instanceof ApiError && metaQuery.error.status === 401)
    || !!metaQuery.data?.archived
  const metadataError = isChild && !metaQuery.isVerified && !metadataExit
    && (metaQuery.isError || retryingMetadata)
  const retryMetadata = useCallback(async () => {
    if (!metadataError || metaQuery.isFetching || retryAttemptRef.current?.scope === retryScope) return
    const attempt = { scope: retryScope }
    retryAttemptRef.current = attempt
    setRetryAttempt(attempt)
    try {
      await metaQuery.refetch({ cancelRefetch: false })
    } finally {
      if (retryAttemptRef.current === attempt) retryAttemptRef.current = null
      setRetryAttempt((current) => current === attempt ? null : current)
    }
  }, [metadataError, metaQuery, retryScope])
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
  const routeLifecycle = !server?.categories
    ? "pending" as const
    : !isChild
      ? "ready" as const
      : metaQuery.isError
        ? "terminal-error" as const
        : model.routeHydrated
          ? "ready" as const
          : "pending" as const
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
    const denied = isDefinitiveChildMetaFailure(metaQuery.error)
    if (denied || metaQuery.data?.archived) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
      removeForumSidebarUnreadChild(queryClient, serverId, channelId)
      removeForumSidebarThreadExact(queryClient, serverId, channelId)
      const lastChannel = getLastChannel(serverId)
      if (lastChannel === channelId) {
        clearLastChannel(serverId)
      }
      const destination = consumeCommunityColdEntryFailure(
        accountId,
        `/c/channels/${serverParam}/${channelId}`,
      )
        ? COMMUNITY_COLD_ENTRY_FALLBACK
        : `/c/channels/${serverParam}`
      router.replace(destination)
    } else if (metaQuery.data && metaQuery.isVerified) {
      useCommunityStore.getState().setCurrentChannelMeta(metaQuery.data)
    } else if (metaQuery.error) {
      useCommunityStore.getState().setCurrentChannelMeta(null)
      toastApiError(metaQuery.error, "Failed to load thread")
    }
  }, [accountId, channelId, isChild, metaQuery.data, metaQuery.error, metaQuery.isVerified, queryClient, router, serverId, serverParam])
  return { ...model, routeLifecycle, metadataError, retryingMetadata, retryMetadata }
}
