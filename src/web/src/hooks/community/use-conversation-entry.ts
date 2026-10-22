"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query"
import { useConversationActivity } from "@/contexts/community/conversation-activity"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { channelHref, normalizeCommunityHref } from "@/lib/community/community-route"
import type { CommunityReadStateResource } from "@alook/shared"
import { useRouteChannelProjection } from "@/lib/community-db/projections"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import {
  conversationEntryOptions, currentConversationReadState, findConversationEntryWindow, getQualifiedConversationEntry,
  type ConversationEntryResource, type ConversationEntryTarget,
} from "@/lib/community/conversation-entry"
import type { MessageWindowData } from "@/lib/community/message-window"
import { reconcileWindow } from "./community-ws/reconnect-messages"
import { isConversationAccessError, isConversationAnchorMissingError } from "@/lib/community/conversation-read"
import { getLocalReadingPosition } from "./read-coordinator"

type EntryWindow = NonNullable<ReturnType<typeof findConversationEntryWindow>>

export function useConversationResource(target: ConversationEntryTarget | null, intent?: { href: string; resume?: boolean } | null, useLocalPosition = false) {
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
  const baseInput = useMemo(() => ({ channelId, serverId, anchorMessageId, tag, preferTail }), [channelId, serverId, anchorMessageId, tag, preferTail])
  const qualification = useMemo(() => ({ accountEpoch, accessEpoch, generation, parentGeneration }), [accountEpoch, accessEpoch, generation, parentGeneration])
  const cachedSelection = useMemo(() => {
    const cached = client.getQueryData<ConversationEntryResource>(conversationEntryOptions(client, baseInput).queryKey)
    return { qualification, intent, resource: cached && isChannelMetadataTokenCurrent(cached.proof) ? cached : getQualifiedConversationEntry(client, channelId) }
  }, [client, baseInput, channelId, qualification, intent])
  const cachedResource = cachedSelection.resource
  const landing = useMemo(() => {
    const search = new URLSearchParams(intent?.href.split("?")[1] ?? "")
    const position = useLocalPosition && enabled && !anchorMessageId && !tag && !preferTail && !intent?.resume && !search.has("msg") && !search.has("seq")
      ? getLocalReadingPosition(client, channelId) : null
    const pointer = currentConversationReadState(client, channelId)
    if (!position || !pointer || pointer.lastReadSeq >= position.seq) return { qualification: cachedSelection.qualification, input: baseInput, requestInput: baseInput, position: null }
    const input = { ...baseInput, anchorMessageId: position.messageId }
    const covered = cachedSelection.resource && findConversationEntryWindow(client, input, cachedSelection.resource, pointer)
    return { qualification: cachedSelection.qualification, input, requestInput: covered ? baseInput : input, position }
  }, [client, baseInput, cachedSelection, intent, useLocalPosition, enabled, anchorMessageId, channelId, tag, preferTail])
  const input = landing.input
  const options = useMemo(() => conversationEntryOptions(client, landing.requestInput), [client, landing])
  const parentId = canonical?.parentChannelId ?? undefined
  const [verification, setVerification] = useState(() => ({ runtime, channelId, serverId,
    needed: !serverRevoked && runtime.ws.actions.isChannelAccessRevoked(channelId, serverId, parentId), generation }))
  if (verification.runtime !== runtime || verification.channelId !== channelId || verification.serverId !== serverId) {
    setVerification({ runtime, channelId, serverId,
      needed: !serverRevoked && runtime.ws.actions.isChannelAccessRevoked(channelId, serverId, parentId), generation })
  }
  const query = useQuery({ ...options, enabled: !!target && !revoked, refetchOnReconnect: false, refetchOnWindowFocus: false })
  const anchorMissing = isConversationAnchorMissingError(query.error)
  const fallbackInput = useMemo(() => ({ ...baseInput, anchorMessageId: null }), [baseInput])
  const fallbackRequest = useMemo(() => ({ qualification, options: conversationEntryOptions(client, fallbackInput) }), [client, fallbackInput, qualification])
  const fallbackOptions = fallbackRequest.options
  const fallback = useQuery({ ...fallbackOptions, enabled: !!target && anchorMissing && !revoked, subscribed: !!target && anchorMissing,
    refetchOnReconnect: false, refetchOnWindowFocus: false })
  const resource = query.data && isChannelMetadataTokenCurrent(query.data.proof) ? query.data
    : fallback.data && isChannelMetadataTokenCurrent(fallback.data.proof) ? fallback.data
      : cachedResource && isChannelMetadataTokenCurrent(cachedResource.proof) ? cachedResource : undefined
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
  }, [client, channelId, intent, input, options, query.data, query.isFetching, query.isError, revoked, target])
  return { client, cachedResource, input: anchorMissing && landing.position ? baseInput : input, options, query, canonical, resource: qualified ? resource : undefined, canRead: qualified, revoked,
    localPosition: anchorMissing ? null : landing.position,
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
  const active = useConversationActivity()
  const incomingIntent = currentIntent && normalizeCommunityHref(currentIntent.href).pathname === expectedPath ? currentIntent : null
  const [retainedIntent, setRetainedIntent] = useState({ path: expectedPath, intent: incomingIntent })
  const resuming = incomingIntent?.resume === true
  useLayoutEffect(() => {
    if (active && !resuming) setRetainedIntent(current => current.path === expectedPath && current.intent === incomingIntent
      ? current : { path: expectedPath, intent: incomingIntent })
  }, [active, expectedPath, incomingIntent, resuming])
  const intent = (active && !resuming) || retainedIntent.path !== expectedPath ? incomingIntent : retainedIntent.intent
  const { client, cachedResource, input, query, canonical, resource, canRead, revoked, denied, anchorMissing, localPosition } = useConversationResource(target, intent, true)
  const canonicalInput = useMemo(() => localPosition ? { ...input, anchorMessageId: null } : input, [input, localPosition])
  const entry = useMemo(() => {
    const pointer = cachedResource && isChannelMetadataTokenCurrent(cachedResource.proof) ? currentConversationReadState(client, input.channelId) : undefined
    const window = cachedResource && pointer ? findConversationEntryWindow(client,
      localPosition && pointer.lastReadSeq >= localPosition.seq ? canonicalInput : input, cachedResource, pointer) : undefined
    return { intent, knownRevision: pointer?.observedRevision ?? -1, state: createStore<{ snapshot: CommunityReadStateResource | null; window: EntryWindow | null }>({
      snapshot: window ? pointer! : null,
      window: window ?? null,
    }) }
  }, [client, cachedResource, input, canonicalInput, localPosition, intent])
  const selected = useSelector(entry.state, (state) => state)
  const currentRevision = currentConversationReadState(client, input.channelId)?.observedRevision ?? -1
  const needsCanonicalWindow = !!localPosition && !selected.window && !!resource && (resource.readStateRevision < currentRevision
    || resource.readStateAtEntry.lastReadSeq >= localPosition.seq && !findConversationEntryWindow(client, canonicalInput, resource, resource.readStateAtEntry))
  const canonicalQuery = useQuery({ ...conversationEntryOptions(client, canonicalInput), enabled: canRead && needsCanonicalWindow,
    subscribed: needsCanonicalWindow, staleTime: 0, refetchOnReconnect: false, refetchOnWindowFocus: false })
  const candidateResource = needsCanonicalWindow && canonicalQuery.data && isChannelMetadataTokenCurrent(canonicalQuery.data.proof)
    && canonicalQuery.data.readStateRevision >= Math.max(entry.knownRevision, currentRevision) ? canonicalQuery.data : resource
  const candidateTarget = localPosition && candidateResource && candidateResource.readStateAtEntry.lastReadSeq >= localPosition.seq
    ? canonicalInput : input
  const candidate = !selected.window && candidateResource && candidateResource.readStateRevision >= Math.max(entry.knownRevision, currentRevision)
    ? findConversationEntryWindow(client, candidateTarget, candidateResource, candidateResource.readStateAtEntry) : undefined
  const window = canRead ? selected.window ?? candidate ?? null : null
  const snapshot = window ? selected.snapshot ?? candidateResource!.readStateAtEntry : null
  useLayoutEffect(() => {
    if (!candidate || !candidateResource) return
    entry.state.setState((state) => state.window ? state : { window: candidate, snapshot: candidateResource.readStateAtEntry })
  }, [candidate, entry, candidateResource])
  useEffect(() => {
    if (!canRead || !window || !resource || hashKey(window.key) === hashKey(resource.windowKey)) return
    const landing = client.getQueryData<MessageWindowData>(resource.windowKey)
    const target = Math.max(0, ...(landing?.pages.map(page => page.latestSeq ?? 0) ?? []))
    void reconcileWindow(client, {
      kind: input.serverId === null ? "dm" : "channel", scopeId: input.channelId, serverId: input.serverId ?? undefined,
    }, window.key, target).catch(() => undefined)
  }, [canRead, client, input.channelId, input.serverId, resource, window])
  const activeQuery = needsCanonicalWindow ? canonicalQuery : query
  const refetch = activeQuery.refetch
  const retry = useCallback(() => refetch({ cancelRefetch: false }), [refetch])
  return { ...activeQuery, intent, resource, canonical, canRead, window, snapshot, revoked, denied, anchorMissing,
    initialPositionMessageId: window && localPosition && snapshot && snapshot.lastReadSeq < localPosition.seq ? localPosition.messageId : null,
    isPending: !!target && !window && !denied && !anchorMissing && !activeQuery.isError && activeQuery.errorUpdatedAt === 0,
    failed: !window && activeQuery.errorUpdatedAt > 0,
    retry, retrying: activeQuery.isFetching,
  }
}
