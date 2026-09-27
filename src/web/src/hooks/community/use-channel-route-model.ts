"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"
import { useCommunityStore } from "@/stores/community"
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
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { purgeCommunityChannel } from "@/lib/community-db/sync"

type Server = ReturnType<typeof useServer>["server"]
type ChannelMeta = NonNullable<ReturnType<typeof useChildChannelMeta>["data"]> | null

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
  const communityDb = useOptionalCommunityDbRegistry()
  const { server } = useServer(serverId)
  const dbChannel = useRouteChannelProjection(channelId)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const topLevelChannel = server?.categories
    ?.flatMap((category) => category.channels)
    .some((candidate) => candidate.id === channelId)
  const isChild = !!server?.categories && !topLevelChannel
  const cachedChildMeta = useMemo(() => dbChannel?.type === "thread"
    && dbChannel.parentChannelId
    && dbChannel.parentMessageId ? {
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
  } : undefined, [accessEpoch, dbChannel, serverId])
  const metaQuery = useChildChannelMeta(serverId, channelId, isChild, cachedChildMeta)
  const renderableChannelMeta = isChild && metaQuery.isVerified
    ? (metaQuery.data ?? null)
    : cachedChildMeta ?? null
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
      renderableChannelMeta,
      channelId,
      isChild
        ? { channelId, settled: metaQuery.isVerified }
        : { channelId, settled: true },
    ),
    [channelId, isChild, metaQuery.isVerified, renderableChannelMeta, server],
  )
  const routeLifecycle = !server?.categories
    ? "pending" as const
    : !isChild
      ? "ready" as const
      : metadataExit || (metaQuery.isError && !model.routeHydrated)
        ? "terminal-error" as const
        : model.routeHydrated
          ? "ready" as const
          : "pending" as const
  const skeletonSubtype = routeLifecycle === "ready"
    ? model.isChild
      ? "thread" as const
      : model.isForum
        ? "forum" as const
        : "text" as const
    : dbChannel?.type === "forum"
      ? "forum" as const
      : dbChannel?.type === "text"
        ? "text" as const
        : dbChannel?.type === "thread"
          ? "thread" as const
          : "unknown" as const
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
      const store = useCommunityStore.getState()
      const routeStillCurrent = store.currentChannelId === channelId
      store.setCurrentChannelMeta(null)
      removeForumSidebarUnreadChild(queryClient, serverId, channelId)
      removeForumSidebarThreadExact(queryClient, serverId, channelId)
      if (communityDb) purgeCommunityChannel(communityDb, channelId)
      const lastChannel = getLastChannel(serverId)
      if (lastChannel === channelId) {
        clearLastChannel(serverId)
      }
      // A top-level delete clears the live pointer and starts its survivor
      // navigation before this fallback metadata request can settle. Do not
      // let the late 403/404 supersede that newer navigation with the root.
      if (!routeStillCurrent) return
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
  }, [accountId, channelId, communityDb, isChild, metaQuery.data, metaQuery.error, metaQuery.isVerified, queryClient, router, serverId, serverParam])
  return {
    ...model,
    routeLifecycle,
    skeletonSubtype,
    metadataError,
    retryingMetadata,
    retryMetadata,
  }
}
