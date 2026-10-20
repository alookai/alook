"use client"

import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { useCommunityRuntime } from "@/stores/community/runtime"


import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { isForum as isForumType, type CommunityChannelResource } from "@alook/shared"
import type { Channel } from "@/lib/community/models/navigation"
import type { ChannelRow } from "@/lib/community-db/schema"
import { useServer } from "./use-servers"

import { toastApiError } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import {
  COMMUNITY_COLD_ENTRY_FALLBACK,
  consumeCommunityColdEntryFailure,
} from "@/lib/community/last-community-route"
import { communityWsSubscribe, communityWsUnsubscribe } from "./use-community-ws"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { useChannelMetadata } from "./use-channel-metadata"
import type { ChildChannelMeta } from "./use-forum-sidebar-threads"


type Server = ReturnType<typeof useServer>["server"]
type ChannelMeta = ChildChannelMeta | null

export function buildChannelRouteModel(
  server: Server,
  currentChannelMeta: ChannelMeta,
  channelId: string,
  metaState: { channelId: string; settled: boolean } | null = null,
  identity?: CommunityChannelResource,
  canonicalParent?: ChannelRow,
) {
  const channels = server?.categories?.flatMap((category) => category.channels) ?? []
  const target = identity?.id === channelId ? identity : undefined
  const directoryChannel = channels.find((candidate) => candidate.id === channelId) ?? null
  const isChild = target ? target.type === "thread" : !directoryChannel && !!server?.categories
  const metaSettled = !isChild || metaState?.channelId === channelId && metaState.settled
  const currentMetaMatches = !currentChannelMeta || !("id" in currentChannelMeta) || currentChannelMeta.id === channelId
  const channelMeta = metaSettled && currentMetaMatches ? currentChannelMeta : null
  const channel: Channel | null = target && (target.type === "text" || target.type === "forum") ? { ...target, type: target.type, name: target.name ?? "", active: false, unread: false }
    : directoryChannel
  const parentId = channelMeta?.parentChannelId
  const parent: Channel | null = parentId && canonicalParent?.id === parentId && !canonicalParent.pending && (canonicalParent.type === "text" || canonicalParent.type === "forum")
    ? { ...canonicalParent, type: canonicalParent.type, name: canonicalParent.name ?? "", active: false, unread: false }
    : channels.find((candidate) => candidate.id === parentId) ?? null
  return {
    server, channel, parent, currentChannelMeta: channelMeta,
    isForum: isForumType(channel?.type), isChild,
    isForumPostChild: isChild && isForumType(parent?.type), isNotifyUnit: isChild,
    metaSettled, routeHydrated: isChild ? metaSettled && channelMeta !== null : channel !== null,
  }
}

export function useChannelRouteModel(
  serverId: string,
  serverParam: string,
  channelId: string,
  accountId: string,
  anchorMessageId?: string | null,
) {
  const active = useConversationActivity()
  const ownedChannel = useRef(channelId)
  useLayoutEffect(() => { ownedChannel.current = channelId }, [channelId])
  const router = useRouter()
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const runtime = useCommunityRuntime()
  const { server } = useServer(serverId)
  const metaQuery = useChannelMetadata(serverId, channelId, { anchorMessageId })
  const identity = metaQuery.canRead && metaQuery.data?.id === channelId && metaQuery.data.serverId === serverId ? metaQuery.data : undefined
  const isChild = identity?.type === "thread"
  const renderableChannelMeta: ChannelMeta = useMemo(() => isChild && identity?.parentChannelId && identity.parentMessageId
    ? { ...identity, serverId, parentChannelId: identity.parentChannelId, parentMessageId: identity.parentMessageId,
        activityAt: identity.lastMessageAt ?? identity.createdAt }
    : null, [isChild, identity, serverId])
  const structuralChannel = metaQuery.canonical?.id === channelId
    && metaQuery.canonical.serverId === serverId && !metaQuery.canonical.pending ? metaQuery.canonical : undefined
  const structuralParentId = identity?.parentChannelId ?? (structuralChannel?.type === "thread" ? structuralChannel.parentChannelId ?? null : null)
  const canonicalParent = useRouteChannelProjection(structuralParentId)
  const metadataExit = metaQuery.denied || metaQuery.isArchived
    || metaQuery.error instanceof ApiError && metaQuery.error.status === 401
  const metadataError = !metadataExit && metaQuery.status === "retryable-error"
  const retryingMetadata = metaQuery.retrying
  const retryMetadata = () => metadataError ? metaQuery.retry() : Promise.resolve()
  const exitScope = JSON.stringify([accountId, serverId, channelId])
  const exited = useRef<{ client: typeof queryClient; scope: string } | null>(null)
  const model = useMemo(() => buildChannelRouteModel(server, renderableChannelMeta, channelId,
    { channelId, settled: metaQuery.canRead }, identity, canonicalParent),
  [server, renderableChannelMeta, channelId, metaQuery.canRead, identity, canonicalParent])
  const routeLifecycle = metaQuery.canRead && !metadataExit ? "ready" as const
    : metadataExit || metadataError ? "terminal-error" as const : "pending" as const
  const skeletonSubtype = routeLifecycle === "ready"
    ? model.isChild ? "thread" as const : model.isForum ? "forum" as const : "text" as const
    : structuralChannel?.type === "forum" ? "forum" as const : structuralChannel?.type === "text" ? "text" as const
    : structuralChannel?.type === "thread" ? "thread" as const : "unknown" as const
  const serverParent = server?.id === serverId
    ? server.categories.flatMap((category) => category.channels)
      .find((candidate) => candidate.id === structuralParentId && !candidate.pending)
    : undefined
  const parentType = serverParent?.type ?? (canonicalParent?.id === structuralParentId
    && canonicalParent.serverId === serverId && !canonicalParent.pending ? canonicalParent.type : undefined)
  const parentSubtype = parentType === "forum" ? "forum" as const
    : parentType === "text" ? "text" as const : "unknown" as const
  const layoutHint = useMemo(() => ({
    subtype: skeletonSubtype,
    parentChannelId: structuralParentId,
    parentSubtype,
  }), [skeletonSubtype, structuralParentId, parentSubtype])
  useEffect(() => {
    if (active) runtime.ui.actions.setCurrentChannelId(channelId)
  }, [active, channelId, runtime])
  useEffect(() => {
    if (active) communityWsSubscribe(runtime, { channelId })
  }, [active, channelId, runtime])
  useEffect(() => () => {
    if (!active) return
    const current = runtime.ui.get().currentChannelId
    if (current !== null && current !== ownedChannel.current) return
    runtime.ui.actions.setCurrentChannelId(null)
    communityWsUnsubscribe(runtime)
  }, [active, runtime])
  useEffect(() => {
    if (!active) return
    if (metaQuery.canRead) exited.current = null
    if (metaQuery.denied || metaQuery.isArchived) {
      if (exited.current?.client === queryClient && exited.current.scope === exitScope) return
      const registry = getCommunityDbRegistry(queryClient)
      if (pathname !== `/c/channels/${serverParam}/${channelId}` || window.location.pathname !== pathname || registry?.accountId !== accountId
        || registry.runtime !== runtime || !runtime.lifecycle.get().active || runtime.ws.get().revokedServerIds.has(serverId)) return
      exited.current = { client: queryClient, scope: exitScope }
      runtime.ui.actions.setCurrentChannelId(null)
      router.replace(consumeCommunityColdEntryFailure(accountId, `/c/channels/${serverParam}/${channelId}`)
        ? COMMUNITY_COLD_ENTRY_FALLBACK : `/c/channels/${serverParam}`)
    } else if (metadataError && metaQuery.error) toastApiError(metaQuery.error, "Failed to load channel")
  }, [active, accountId, channelId, exitScope, metaQuery.canRead, metaQuery.denied, metaQuery.error, metaQuery.isArchived, metadataError, pathname, queryClient, router, runtime, serverId, serverParam])

  return {
    ...model,
    routeHydrated: model.routeHydrated && metaQuery.canRead && !metadataExit,
    routeLifecycle,
    skeletonSubtype,
    layoutHint,
    metadataError,
    retryingMetadata,
    retryMetadata,
  }
}
