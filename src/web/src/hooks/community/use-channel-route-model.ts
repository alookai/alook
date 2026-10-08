"use client"

import { useCommunityRuntime } from "@/stores/community/runtime"


import { useEffect, useMemo, useRef } from "react"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType } from "@alook/shared"
import { useServer } from "./use-servers"

import { toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "@/lib/community/last-community-route"
import { communityWsSubscribe, communityWsUnsubscribe } from "./use-community-ws"
import { useChannelMetadata } from "./use-channel-metadata"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"

import { useConversationReadRetry } from "./use-conversation-read-retry"

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
  const serverQuery = useServer(serverId)
  const { server } = serverQuery
  const topLevelChannel = server?.categories
    ?.flatMap((category) => category.channels)
    .some((candidate) => candidate.id === channelId)
  const isChild = !!server?.categories && !topLevelChannel
  const metaQuery = useChannelMetadata(serverId, channelId)
  const renderableChannelMeta: ChannelMeta = useMemo(() => isChild && metaQuery.canRead
    && metaQuery.data?.serverId === serverId && metaQuery.data.parentChannelId && metaQuery.data.parentMessageId
    ? { ...metaQuery.data, serverId,
        parentChannelId: metaQuery.data.parentChannelId,
        parentMessageId: metaQuery.data.parentMessageId,
        activityAt: metaQuery.data.lastMessageAt ?? metaQuery.data.createdAt }
    : null, [isChild, metaQuery.data, metaQuery.canRead, serverId])
  const serverRetry = useConversationReadRetry(serverQuery, queryClient, [accountId, serverId])
  const serverError = !server?.categories && serverRetry.failed
  const retryingServer = serverRetry.retrying
  const retryServer = serverRetry.retry
  const metadataExit = metaQuery.denied || metaQuery.isArchived
    || metaQuery.error instanceof ApiError && metaQuery.error.status === 401
  const metadataError = !metadataExit && metaQuery.status === "retryable-error"
  const retryingMetadata = metaQuery.retrying
  const retryMetadata = () => metadataError ? metaQuery.retry() : Promise.resolve()
  const exitScope = JSON.stringify([accountId, serverId, channelId])
  const exited = useRef<{ client: typeof queryClient; scope: string } | null>(null)
  const model = useMemo(
    () => buildChannelRouteModel(
      server,
      renderableChannelMeta,
      channelId,
      isChild
        ? { channelId, settled: metaQuery.canRead }
        : { channelId, settled: true },
    ),
    [channelId, isChild, metaQuery.canRead, renderableChannelMeta, server],
  )
  const routeLifecycle = !server?.categories
    ? serverError ? "terminal-error" as const : "pending" as const
    : !isChild && metaQuery.canRead && !metadataExit
      ? "ready" as const
      : metadataExit || (metaQuery.isError && !metaQuery.canRead)
        ? "terminal-error" as const
        : model.routeHydrated && metaQuery.canRead && !metadataExit
          ? "ready" as const
          : "pending" as const
  const skeletonSubtype = routeLifecycle === "ready"
    ? model.isChild
      ? "thread" as const
      : model.isForum
        ? "forum" as const
        : "text" as const
    : metaQuery.canonical?.type === "forum"
      ? "forum" as const
      : metaQuery.canonical?.type === "text"
        ? "text" as const
        : metaQuery.canonical?.type === "thread"
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
    if (metaQuery.canRead) exited.current = null
    if (metaQuery.denied || metaQuery.isArchived) {
      if (exited.current?.client === queryClient && exited.current.scope === exitScope) return
      exited.current = { client: queryClient, scope: exitScope }
      if (runtime.ui.get().currentChannelId !== channelId || runtime.ws.get().revokedServerIds.has(serverId)) return
      runtime.ui.actions.setCurrentChannelId(null)
      router.replace(consumeCommunityColdEntryFailure(accountId, `/c/channels/${serverParam}/${channelId}`)
        ? COMMUNITY_COLD_ENTRY_FALLBACK : `/c/channels/${serverParam}`)
    } else if (metadataError && metaQuery.error) toastApiError(metaQuery.error, "Failed to load channel")
  }, [accountId, channelId, exitScope, metaQuery.canRead, metaQuery.denied, metaQuery.error, metaQuery.isArchived, metadataError, queryClient, router, runtime, serverId, serverParam])

  return {
    ...model,
    routeHydrated: model.routeHydrated && metaQuery.canRead && !metadataExit,
    routeLifecycle,
    skeletonSubtype,
    metadataError,
    serverError,
    retryingServer,
    retryServer,
    retryingMetadata,
    retryMetadata,
  }
}
