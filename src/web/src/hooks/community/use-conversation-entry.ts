"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { channelHref, normalizeCommunityHref } from "@/lib/community/community-route"
import type { CommunityReadStateResource } from "@alook/shared"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import {
  conversationEntryOptions, currentConversationReadState, findConversationEntryWindow,
  type ConversationEntryResource, type ConversationEntryTarget,
} from "@/lib/community/conversation-entry"
import { isConversationAccessError, isConversationAnchorMissingError } from "@/lib/community/conversation-read"

type EntryWindow = NonNullable<ReturnType<typeof findConversationEntryWindow>>

export function useConversationResource(target: ConversationEntryTarget | null, intent?: { href: string } | null) {
  const client = useQueryClient()
  const runtime = useCommunityRuntime()
  const canonical = useRouteChannelProjection(target?.channelId ?? null)
    ?? (target ? getCommunityDbRegistry(client)?.collections.channels.get(target.channelId) : undefined)
  const [accountEpoch, accessEpoch, generation, parentGeneration, revoked, serverRevoked] = useSelector(runtime.ws, (state) => [state.profileAccountEpoch, state.accessEpoch,
    target ? state.channelAccessScopes.get(target.channelId)?.generation ?? 0 : 0,
    canonical?.parentChannelId ? state.channelAccessScopes.get(canonical.parentChannelId)?.generation ?? 0 : 0,
    !!target && runtime.ws.actions.isChannelAccessRevoked(target.channelId, target.serverId, canonical?.parentChannelId ?? undefined),
    !!target?.serverId && state.revokedServerIds.has(target.serverId),
  ] as const, { compare: (left, right) => left.every((value, index) => value === right[index]) })
  const channelId = target?.channelId ?? "__none__"
  const serverId = target?.serverId ?? null
  const anchorMessageId = target?.anchorMessageId ?? null
  const tag = target?.tag ?? null
  const preferTail = target?.preferTail === true
  const enabled = target !== null
  const input = useMemo(() => ({ channelId, serverId, anchorMessageId, tag, preferTail }), [channelId, serverId, anchorMessageId, tag, preferTail])
  const options = useMemo(() => conversationEntryOptions(client, input), [client, input, accountEpoch, accessEpoch, generation, parentGeneration, intent])
  const parentId = canonical?.parentChannelId ?? undefined
  const verification = useMemo(() => ({ needed: !serverRevoked && runtime.ws.actions.isChannelAccessRevoked(channelId, serverId, parentId), generation }), [runtime, channelId, serverId])
  const query = useQuery({ ...options, enabled: !!target && !revoked, refetchOnReconnect: false, refetchOnWindowFocus: false })
  const anchorMissing = isConversationAnchorMissingError(query.error)
  const fallbackInput = useMemo(() => ({ ...input, anchorMessageId: null }), [input])
  const fallbackOptions = useMemo(() => conversationEntryOptions(client, fallbackInput), [client, fallbackInput, accountEpoch, accessEpoch, generation, parentGeneration])
  const fallback = useQuery({ ...fallbackOptions, enabled: !!target && anchorMissing && !revoked, subscribed: !!target && anchorMissing,
    refetchOnReconnect: false, refetchOnWindowFocus: false })
  const resource = query.data && isChannelMetadataTokenCurrent(query.data.proof) ? query.data
    : fallback.data && isChannelMetadataTokenCurrent(fallback.data.proof) ? fallback.data : undefined
  const qualified = !!target && !!canonical && !!resource && !revoked
    && canonical.id === channelId && canonical.serverId === serverId && !canonical.archived
  const refetch = query.refetch
  useEffect(() => { if (enabled && verification.needed) void refetch({ cancelRefetch: false }) }, [refetch, verification, enabled])
  useEffect(() => {
    if (!target || revoked || !query.data || isChannelMetadataTokenCurrent(query.data.proof) || query.isFetching || query.isError) return
    void client.invalidateQueries({ queryKey: options.queryKey, exact: true })
  }, [client, parentGeneration, options.queryKey, query.data, query.isFetching, query.isError, revoked, target])
  const fallbackRefetch = fallback.refetch
  const retryVerification = useCallback(() => (anchorMissing ? fallbackRefetch : refetch)({ cancelRefetch: false }), [anchorMissing, fallbackRefetch, refetch])
  useEffect(() => {
    if (!target || !intent || revoked || !query.data || query.isFetching || query.isError) return
    const pointer = currentConversationReadState(client, channelId)
    if (pointer && !findConversationEntryWindow(client, input, query.data, pointer)) void client.query({ ...options, select: undefined }).catch(() => undefined)
  }, [client, intent, input, options, revoked])
  return { client, input, options, query, canonical, resource: qualified ? resource : undefined, canRead: qualified, revoked,
    denied: serverRevoked || revoked && (!verification.needed || generation !== verification.generation) || isConversationAccessError(query.error) && Number((query.error as { status?: unknown } | null)?.status) !== 401, anchorMissing,
    verificationError: (!qualified && anchorMissing ? fallback.error : query.error)?.name === "AbortError" ? null : !qualified && anchorMissing ? fallback.error : query.error,
    verificationPending: !qualified && (anchorMissing ? fallback.isPending : query.isPending),
    verificationFetching: anchorMissing ? fallback.isFetching : query.isFetching,
    verificationFailed: (anchorMissing ? fallback.error : query.error)?.name !== "AbortError" && (anchorMissing ? fallback.errorUpdatedAt : query.errorUpdatedAt) > 0, retryVerification,
  }
}

export function useConversationEntry(target: ConversationEntryTarget | null) {
  const context = useContext(CommunityRouteContext)
  const currentIntent = context?.navigation.entryIntent
  const expectedPath = target ? target.serverId === null ? `/c/me/${encodeURIComponent(target.channelId)}` : channelHref(target.serverId, target.channelId) : null
  const intent = currentIntent && normalizeCommunityHref(currentIntent.href).pathname === expectedPath ? currentIntent : null
  const { client, input, options, query, canonical, resource, canRead, revoked, denied, anchorMissing } = useConversationResource(target, intent)
  const entry = useMemo(() => {
    const cached = client.getQueryData<ConversationEntryResource>(options.queryKey)
    const pointer = cached && isChannelMetadataTokenCurrent(cached.proof) ? currentConversationReadState(client, input.channelId) : undefined
    const window = cached && pointer ? findConversationEntryWindow(client, input, cached, pointer) : undefined
    return { knownRevision: pointer?.observedRevision ?? -1, state: createStore<{ snapshot: CommunityReadStateResource | null; window: EntryWindow | null }>({
      snapshot: window ? pointer! : null,
      window: window ?? null,
    }) }
  }, [client, input, options, intent])
  const selected = useSelector(entry.state, (state) => state)
  const candidate = !selected.window && resource && resource.readStateRevision >= entry.knownRevision
    ? findConversationEntryWindow(client, input, resource, resource.readStateAtEntry) : undefined
  const window = canRead ? selected.window ?? candidate ?? null : null
  const snapshot = window ? selected.snapshot ?? resource!.readStateAtEntry : null
  useLayoutEffect(() => {
    if (!candidate || !resource) return
    entry.state.setState((state) => state.window ? state : { window: candidate, snapshot: resource.readStateAtEntry })
  }, [candidate, entry, resource])
  const refetch = query.refetch
  const retry = useCallback(() => { void refetch({ cancelRefetch: false }) }, [refetch])
  return { ...query, intent, resource, canonical, canRead, window, snapshot, revoked, denied, anchorMissing,
    isPending: !!target && !window && !denied && !anchorMissing && !query.isError && query.errorUpdatedAt === 0,
    failed: !window && query.errorUpdatedAt > 0,
    retry, retrying: query.isFetching,
  }
}
