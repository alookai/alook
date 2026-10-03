"use client"

import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useCallback, useEffect, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"

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
import { useChannelMetadata } from "./use-channel-metadata"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"
import {
  removeForumSidebarThreadExact,
  removeForumSidebarUnreadChild,
} from "./use-forum-sidebar-threads"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import { purgeCommunityChannel } from "@/lib/community-db/sync"

type Server = ReturnType<typeof useServer>["server"]
type ChannelMeta = ChildChannelMeta | null

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
  const runtime = useCommunityRuntime()
  const communityDb = useOptionalCommunityDbRegistry()
  const { server } = useServer(serverId)
  const dbChannel = useRouteChannelProjection(channelId)
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const topLevelChannel = server?.categories
    ?.flatMap((category) => category.channels)
    .some((candidate) => candidate.id === channelId)
  const isChild = !!server?.categories && !topLevelChannel
  const metaQuery = useChannelMetadata(serverId, channelId)
  const renderableChannelMeta: ChannelMeta = useMemo(() => isChild && metaQuery.isVerified
    && metaQuery.data?.serverId === serverId && metaQuery.data.parentChannelId && metaQuery.data.parentMessageId
    ? { ...metaQuery.data, serverId,
        parentChannelId: metaQuery.data.parentChannelId,
        parentMessageId: metaQuery.data.parentMessageId,
        activityAt: metaQuery.data.lastMessageAt ?? metaQuery.data.createdAt }
    : null, [isChild, metaQuery.data, metaQuery.isVerified, serverId])
  const retryScope = JSON.stringify([accountId, serverId, channelId, accessEpoch])
  const exitScope = JSON.stringify([accountId, serverId, channelId])
  const [exitedMetadata, setExitedMetadata] = useAtom(useCreateAtom<{ owner: typeof communityDb; scope: string } | null>(null))
  const freshMetadata = metaQuery.isVerified && !metaQuery.data?.archived
    && !isDefinitiveChildMetaFailure(metaQuery.error)
    && !(metaQuery.error instanceof ApiError && metaQuery.error.status === 401)
  const metadataExited = exitedMetadata?.owner === communityDb && exitedMetadata?.scope === exitScope
    && !freshMetadata
  useEffect(() => {
    if (freshMetadata && exitedMetadata?.owner === communityDb && exitedMetadata.scope === exitScope) {
      setExitedMetadata(null)
    }
  }, [communityDb, exitScope, exitedMetadata, freshMetadata, setExitedMetadata])
  const retryAttemptRef = useRef<{ scope: string } | null>(null)
  const [retryAttempt, setRetryAttempt] = useAtom(useCreateAtom<{ scope: string } | null>(null))
  const retryingMetadata = retryAttempt?.scope === retryScope
  const metadataExit = metadataExited || isDefinitiveChildMetaFailure(metaQuery.error)
    || (metaQuery.error instanceof ApiError && metaQuery.error.status === 401)
    || !!metaQuery.data?.archived
  const metadataError = !metaQuery.isVerified && !metadataExit
    && (metaQuery.isError || retryingMetadata)
  const { refetch: refetchMetadata, isFetching: fetchingMetadata } = metaQuery
  const retryMetadata = useCallback(async () => {
    if (!metadataError || fetchingMetadata || retryAttemptRef.current?.scope === retryScope) return
    const attempt = { scope: retryScope }
    retryAttemptRef.current = attempt
    setRetryAttempt(attempt)
    try {
      await refetchMetadata({ cancelRefetch: false })
    } finally {
      if (retryAttemptRef.current === attempt) retryAttemptRef.current = null
      setRetryAttempt((current) => current === attempt ? null : current)
    }
  }, [metadataError, fetchingMetadata, refetchMetadata, retryScope, setRetryAttempt])
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
    : !isChild && metaQuery.isVerified
      ? "ready" as const
      : metadataExit || (metaQuery.isError && !metaQuery.isVerified)
        ? "terminal-error" as const
        : model.routeHydrated && metaQuery.isVerified
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
    runtime.ui.actions.setCurrentChannelId(channelId)
    return () => { runtime.ui.actions.setCurrentChannelId(null) }
  }, [channelId, runtime])
  useEffect(() => {
    communityWsSubscribe(runtime, { channelId })
    return () => communityWsUnsubscribe(runtime)
  }, [channelId, runtime])
  useEffect(() => {
    const denied = isDefinitiveChildMetaFailure(metaQuery.error)
    if (!isChild && !denied && !metaQuery.data?.archived) {
      return
    }
    if (denied || metaQuery.data?.archived) {
      if (metadataExited) return
      setExitedMetadata({ owner: communityDb, scope: exitScope })
      const store = runtime.ui.get()
      const routeStillCurrent = store.currentChannelId === channelId
      if (communityDb) purgeCommunityChannel(communityDb, channelId)
      if (!runtime.ws.actions.isChannelAccessRevoked(channelId, serverId)) runtime.ws.actions.revokeChannelAccess(serverId, channelId)
      removeForumSidebarUnreadChild(queryClient, serverId, channelId)
      removeForumSidebarThreadExact(queryClient, serverId, channelId)
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
    } else if (metaQuery.error) {
      toastApiError(metaQuery.error, "Failed to load channel")
    }
  }, [accountId, channelId, communityDb, isChild, metaQuery.data, metaQuery.error, metaQuery.isVerified, queryClient, renderableChannelMeta, router, runtime.ui, runtime.ws.actions, serverId, serverParam, metadataExited, exitScope, setExitedMetadata])
  return {
    ...model,
    routeHydrated: model.routeHydrated && metaQuery.isVerified,
    routeLifecycle,
    skeletonSubtype,
    metadataError,
    retryingMetadata,
    retryMetadata,
  }
}
