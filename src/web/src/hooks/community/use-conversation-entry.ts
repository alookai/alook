"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query"
import { useConversationActivity, useConversationPresentation } from "@/contexts/community/conversation-activity"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { channelHref, normalizeCommunityHref } from "@/lib/community/community-route"
import { communityMessageProfileIds, CommunityMessageResourceSchema, CommunityResourceProfileSchema, type CommunityReadStateResource } from "@alook/shared"
import { useCanonicalMessagesById, useCanonicalProfilesProjection, useChannelReadStateProjection, useChannelRosterRows, useRouteChannelProjection } from "@/lib/community-db/projections"
import { getCanonicalCommunityMessageResources } from "@/lib/community-db/sync"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import { actionAttributes, currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { emitTelemetry, telemetryGeneration } from "@/lib/observability/telemetry"
import {
  assessConversationScope, conversationEntryOptions, currentConversationReadState, findConversationDisplayWindow, findConversationEntryWindow, getQualifiedConversationEntry, getQualifiedConversationScope,
  type ConversationEntryResource, type ConversationEntryTarget,
} from "@/lib/community/conversation-entry"
import { messageWindowIdentity, type MessageWindowData } from "@/lib/community/message-window"
import { communityKeys } from "@/lib/query-keys"
import { reconcileWindow } from "./community-ws/reconnect-messages"
import { isConversationAccessError, isConversationAnchorMissingError } from "@/lib/community/conversation-read"
import { getLocalReadingPosition } from "./read-coordinator"

type EntryWindow = NonNullable<ReturnType<typeof findConversationEntryWindow>>

export function useConversationResource(target: ConversationEntryTarget | null, intent?: { href: string; resume?: boolean } | null, useLocalPosition = false, consumer: "metadata" | "messages" | "forum" = "metadata", networkEnabled = true) {
  const client = useQueryClient()
  const active = useConversationActivity()
  const presented = useConversationPresentation()
  const runtime = useCommunityRuntime()
  const canonical = useRouteChannelProjection(target?.channelId ?? null)
    ?? (target ? getCommunityDbRegistry(client)?.collections.channels.get(target.channelId) : undefined)
  useRouteChannelProjection(canonical?.parentChannelId ?? null)
  useChannelRosterRows(target?.channelId ?? "", "access")
  useChannelRosterRows(canonical?.parentChannelId ?? "", "access")
  const read = useChannelReadStateProjection(target?.channelId ?? null)
  const lifetime = useSelector(runtime.lifecycle, state => state.active ? state.generation : -1)
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
  const enabled = target !== null && networkEnabled
  const baseInput = useMemo(() => ({ channelId, serverId, anchorMessageId, tag, preferTail }), [channelId, serverId, anchorMessageId, tag, preferTail])
  const qualification = useMemo(() => ({ accountEpoch, accessEpoch, generation, parentGeneration, lifetime, parentId: canonical?.parentChannelId }),
    [accountEpoch, accessEpoch, generation, parentGeneration, lifetime, canonical?.parentChannelId])
  const assessment = assessConversationScope(client, baseInput)
  const scopeAvailable = !!target && !!assessment.scope
  const scope = useMemo(() => ({ qualification, value: scopeAvailable ? getQualifiedConversationScope(client, baseInput) : undefined }),
    [scopeAvailable, client, baseInput, qualification]).value
  const cachedSelection = useMemo(() => {
    const cached = client.getQueryData<ConversationEntryResource>(conversationEntryOptions(client, baseInput).queryKey)
    return { qualification, intent, scope, resource: cached && isChannelMetadataTokenCurrent(cached.proof) ? cached : getQualifiedConversationEntry(client, channelId) }
  }, [client, baseInput, channelId, qualification, intent, scope])
  const cachedResource = cachedSelection.resource
  const landing = useMemo(() => {
    const search = new URLSearchParams(intent?.href.split("?")[1] ?? "")
    const position = useLocalPosition && enabled && !anchorMessageId && !tag && !preferTail && !intent?.resume && !search.has("msg") && !search.has("seq")
      ? getLocalReadingPosition(client, channelId) : null
    const pointer = currentConversationReadState(client, channelId)
    if (!position || !pointer || pointer.lastReadSeq >= position.seq) return { qualification: cachedSelection.qualification, input: baseInput, requestInput: baseInput, position: null }
    const input = { ...baseInput, anchorMessageId: position.messageId }
    const cachedScope = cachedSelection.resource ?? cachedSelection.scope
    const covered = cachedScope && findConversationEntryWindow(client, input, cachedScope, pointer)
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
  const query = useQuery({ ...options, enabled: presented && enabled && !revoked, refetchOnReconnect: false, refetchOnWindowFocus: false })
  const anchorMissing = isConversationAnchorMissingError(query.error)
  const fallbackInput = useMemo(() => ({ ...baseInput, anchorMessageId: null }), [baseInput])
  const fallbackRequest = useMemo(() => ({ qualification, options: conversationEntryOptions(client, fallbackInput) }), [client, fallbackInput, qualification])
  const fallbackOptions = fallbackRequest.options
  const fallback = useQuery({ ...fallbackOptions, enabled: presented && enabled && anchorMissing && !revoked, subscribed: !!target && anchorMissing,
    refetchOnReconnect: false, refetchOnWindowFocus: false })
  const resource = query.data && isChannelMetadataTokenCurrent(query.data.proof) ? query.data
    : fallback.data && isChannelMetadataTokenCurrent(fallback.data.proof) ? fallback.data
      : cachedResource && isChannelMetadataTokenCurrent(cachedResource.proof) ? cachedResource : undefined
  const readableScope = useMemo(() => scope ?? resource, [scope, resource])
  const qualified = !!target && !!canonical && !!readableScope && !revoked
    && canonical.id === channelId && canonical.serverId === serverId && !canonical.archived
  const refetch = query.refetch
  useEffect(() => { if (presented && enabled && verification.needed) void refetch({ cancelRefetch: false }) }, [refetch, verification, enabled, presented])
  useEffect(() => {
    if (!presented || !target || revoked || !query.data || isChannelMetadataTokenCurrent(query.data.proof) || query.isFetching || query.isError) return
    void client.invalidateQueries({ queryKey: options.queryKey, exact: true })
  }, [client, parentGeneration, options.queryKey, query.data, query.isFetching, query.isError, revoked, target, presented])
  const fallbackRefetch = fallback.refetch
  const retryVerification = useCallback(() => (anchorMissing ? fallbackRefetch : refetch)({ cancelRefetch: false }), [anchorMissing, fallbackRefetch, refetch])
  useEffect(() => {
    if (!presented || !target || !intent || revoked || !query.data || query.isFetching || query.isError) return
    if (client.getQueryData(options.queryKey) !== query.data) return
    const pointer = currentConversationReadState(client, channelId)
    const received = client.getQueryData<MessageWindowData>(query.data.windowKey)
    const anchor = input.anchorMessageId ?? pointer?.lastReadMessageId
    if (received?.pages?.some(page => Array.isArray(page.messages) && (anchor ? page.messages.some(message => message.id === anchor) : page.hasMoreNewer === false))) return
    if (pointer && !findConversationEntryWindow(client, input, query.data, pointer)) void client.query({ ...options, select: undefined }).catch(() => undefined)
  }, [client, channelId, intent, input, options, query.data, query.isFetching, query.isError, revoked, target, presented])
  const currentPointer = read.readState ?? (read.hasSnapshot ? currentConversationReadState(client, channelId) : undefined)
  const retainedIds = client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages(channelId) }).flatMap(query => {
    const identity = messageWindowIdentity(query.queryKey)
    if (!identity || identity.tag !== tag || identity.initial.mode === "since") return []
    const value = query.state.data as MessageWindowData | undefined
    if (!Array.isArray(value?.pages) || !Array.isArray(value.pageParams) || !value.pages.length || value.pages.length !== value.pageParams.length
      || value.pages.some(page => !Array.isArray(page?.messages) || page.messages.some(message => typeof message?.id !== "string" || !message.id))) return []
    return value.pages.flatMap(page => page.messages.map(message => message.id))
  })
  const forumMessageIds: string[] = []
  const forum = client.getQueryData<{ pages: import("./forum-feed-window").ForumFeedPage[] }>(communityKeys.forumFeed(channelId, tag))
  if (Array.isArray(forum?.pages)) for (const page of forum.pages) if (Array.isArray(page?.threads)) for (const thread of page.threads) {
    if (!thread || typeof thread.id !== "string") continue
    if (typeof thread.openerMessageId === "string") forumMessageIds.push(thread.openerMessageId)
    const child = getCommunityDbRegistry(client)?.collections.channels.get(thread.id)
    if (child?.firstMessageId) forumMessageIds.push(child.firstMessageId)
  }
  retainedIds.push(...forumMessageIds)
  const retainedMessages = useCanonicalMessagesById([...new Set(retainedIds)])
  const retainedResources = [...(retainedMessages?.keys() ?? [])].flatMap(id => {
    const parsed = CommunityMessageResourceSchema.strip().safeParse(getCommunityDbRegistry(client)?.collections.messages.get(id))
    return parsed.success ? [parsed.data] : []
  })
  const retainedProfileIds = communityMessageProfileIds(retainedResources)
  const retainedProfiles = useCanonicalProfilesProjection(retainedProfileIds)
  const availableWindow = readableScope ? findConversationDisplayWindow(client, baseInput, readableScope) : undefined
  const availableMessageIds = availableWindow && messageWindowIdentity(availableWindow.key)
    ? client.getQueryData<MessageWindowData>(availableWindow.key)!.pages.flatMap(page => page.messages.map(message => message.id))
    : forumMessageIds
  const availableGraph = availableWindow ? getCanonicalCommunityMessageResources(client,
    availableMessageIds.map(id => getCommunityDbRegistry(client)?.collections.messages.get(id))) : undefined
  const requiredProfileIds = availableGraph?.profiles.map(profile => profile.id) ?? retainedProfileIds
  const profilesReady = requiredProfileIds.length === 0 || retainedProfiles.isReady && !retainedProfiles.isError
    && requiredProfileIds.every(id => CommunityResourceProfileSchema.strip().safeParse(retainedProfiles.resourceProfiles.get(id)).success)
  const cachedWindow = profilesReady ? availableWindow : undefined
  const dependencyWindowKey = availableWindow?.key ?? resource?.windowKey
  const dependencyWindow = dependencyWindowKey && messageWindowIdentity(dependencyWindowKey)
    ? client.getQueryData<MessageWindowData>(dependencyWindowKey) : undefined
  const dependencyIds = dependencyWindow && Array.isArray(dependencyWindow.pages) && dependencyWindow.pages.every(page => Array.isArray(page?.messages) && page.messages.every(message => typeof message?.id === "string" && message.id))
    ? dependencyWindow.pages.flatMap(page => page.messages.map(message => message.id)) : canonical?.type === "forum" ? forumMessageIds : undefined
  const retainedBodiesReady = dependencyIds === undefined || dependencyIds.every(id => getCommunityDbRegistry(client)?.collections.messages.get(id)?.channelId === channelId)
  const cachedData = cachedWindow ? client.getQueryData<{ pages: Array<{ messages?: unknown[]; threads?: unknown[] }> }>(cachedWindow.key) : undefined
  const rawWindowExists = canonical?.type === "forum" && !anchorMessageId ? client.getQueryData(communityKeys.forumFeed(channelId, tag)) !== undefined
    : client.getQueryCache().findAll({ queryKey: communityKeys.channelMessages(channelId) }).some(query => {
      const identity = messageWindowIdentity(query.queryKey)
      return !!identity && identity.tag === tag && identity.initial.mode !== "since" && query.state.data !== undefined
    })
  useEffect(() => {
    if (presented && enabled && qualified && rawWindowExists && retainedProfiles.isReady && !retainedProfiles.isError && retainedBodiesReady && !availableWindow && query.isSuccess && !query.isFetching) {
      void refetch({ cancelRefetch: false })
    }
  }, [presented, enabled, qualified, rawWindowExists, retainedProfiles.isReady, retainedProfiles.isError, retainedBodiesReady, availableWindow, query.isSuccess, query.isFetching, refetch])
  const windowReady = qualified && currentPointer !== undefined && cachedWindow !== undefined
  const cacheWindow = !cachedWindow ? rawWindowExists ? "incomplete" : "missing" : cachedData?.pages.some(page => (page.messages ?? page.threads ?? []).length > 0) ? "ready" : "empty"
  const targetCoverage = scope && findConversationEntryWindow(client, baseInput, resource ?? scope, currentPointer) ? "covered" : "uncovered"
  const entryStatus = resource ? "current" : client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries(channelId) }).some(candidate => candidate.state.data !== undefined) ? "stale" : "missing"
  const telemetryOwner = telemetryGeneration()
  useEffect(() => {
    if (!enabled || !active || telemetryOwner !== telemetryGeneration() || typeof window === "undefined") return
    const href = intent?.href ?? window.location.pathname + window.location.search
    const expected = serverId === null ? `/c/me/${encodeURIComponent(channelId)}` : channelHref(serverId, channelId)
    if (normalizeCommunityHref(href).pathname !== expected) return
    const action = navigationForHref(href) ?? (window.location.pathname === expected ? currentPageObservation() : undefined)
    emitTelemetry("conversation.cache", { ...actionAttributes(action), cache_consumer: consumer, cache_reason: assessment.reason,
      cache_window: cacheWindow, entry_status: entryStatus, target_coverage: targetCoverage, eligibility: scopeAvailable ? "eligible" : "rejected" })
  }, [active, assessment.reason, cacheWindow, channelId, consumer, enabled, entryStatus, intent, scopeAvailable, serverId, targetCoverage, telemetryOwner])
  return { client, cachedResource, scope: readableScope, currentPointer, windowReady, displayWindow: cachedWindow, input: anchorMissing && landing.position ? baseInput : input, options, query, canonical, resource: qualified ? resource : undefined, canRead: qualified, revoked,
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
  const presented = useConversationPresentation()
  const incomingIntent = currentIntent && normalizeCommunityHref(currentIntent.href).pathname === expectedPath ? currentIntent : null
  const [retainedIntent, setRetainedIntent] = useState({ path: expectedPath, intent: incomingIntent })
  const resuming = incomingIntent?.resume === true
  useLayoutEffect(() => {
    if (active && !resuming) setRetainedIntent(current => current.path === expectedPath && current.intent === incomingIntent
      ? current : { path: expectedPath, intent: incomingIntent })
  }, [active, expectedPath, incomingIntent, resuming])
  const intent = (active && !resuming) || retainedIntent.path !== expectedPath ? incomingIntent : retainedIntent.intent
  const { client, cachedResource, scope, currentPointer, input, options: entryOptions, query, canonical, resource, canRead, windowReady, revoked, denied, anchorMissing, localPosition } = useConversationResource(target, intent, true, "messages")
  const canonicalInput = useMemo(() => localPosition ? { ...input, anchorMessageId: null } : input, [input, localPosition])
  const entry = useMemo(() => {
    const pointer = scope ? currentConversationReadState(client, input.channelId) : undefined
    const cachedScope = cachedResource ?? scope
    const covered = cachedScope ? findConversationEntryWindow(client,
      localPosition && pointer && pointer.lastReadSeq >= localPosition.seq ? canonicalInput : input, cachedScope, pointer) : undefined
    const window = covered ?? (cachedScope ? findConversationDisplayWindow(client, input, cachedScope) : undefined)
    return { intent, knownRevision: pointer?.observedRevision ?? -1, state: createStore<{ snapshot: CommunityReadStateResource | null; window: EntryWindow | null; covered: boolean }>({
      snapshot: pointer ?? null,
      window: window ?? null, covered: !!covered,
    }) }
  }, [client, cachedResource, scope, input, canonicalInput, localPosition, intent])
  const selected = useSelector(entry.state, (state) => state)
  const currentRevision = currentPointer?.observedRevision ?? -1
  const needsCanonicalWindow = !!localPosition && !!resource && (resource.readStateRevision < currentRevision && !findConversationEntryWindow(client, canonicalInput, resource, currentPointer)
    || resource.readStateAtEntry.lastReadSeq >= localPosition.seq && !findConversationEntryWindow(client, canonicalInput, resource, resource.readStateAtEntry))
  const canonicalQuery = useQuery({ ...conversationEntryOptions(client, canonicalInput), enabled: presented && canRead && needsCanonicalWindow,
    subscribed: needsCanonicalWindow, staleTime: 0, refetchOnReconnect: false, refetchOnWindowFocus: false })
  const candidateResource = needsCanonicalWindow && canonicalQuery.data && isChannelMetadataTokenCurrent(canonicalQuery.data.proof)
    && canonicalQuery.data.readStateRevision >= Math.max(entry.knownRevision, currentRevision) ? canonicalQuery.data : resource
  const candidatePointer = candidateResource && candidateResource.readStateRevision >= Math.max(entry.knownRevision, currentRevision)
    ? candidateResource.readStateAtEntry : scope ? currentConversationReadState(client, input.channelId) : undefined
  const candidateTarget = localPosition && candidatePointer && candidatePointer.lastReadSeq >= localPosition.seq
    ? canonicalInput : input
  const candidateScope = candidateResource ?? scope
  const candidate = (!selected.covered || needsCanonicalWindow) && candidateScope
    ? findConversationEntryWindow(client, candidateTarget, candidateScope, candidatePointer) : undefined
  const display = !selected.window && candidateScope ? findConversationDisplayWindow(client, input, candidateScope) : undefined
  const window = canRead ? candidate ?? selected.window ?? display ?? null : null
  const snapshot = window ? (needsCanonicalWindow || !selected.covered ? candidatePointer ?? selected.snapshot : selected.snapshot) ?? null : null
  const targetCovered = canRead && (needsCanonicalWindow ? !!candidate : selected.covered || !!candidate)
  useLayoutEffect(() => {
    if (!window || !snapshot || selected.window === window && selected.snapshot === snapshot && selected.covered === targetCovered) return
    entry.state.setState(() => ({ window, snapshot, covered: targetCovered }))
  }, [window, snapshot, targetCovered, entry, selected])
  useEffect(() => {
    if (!presented || query.isFetching || !canRead || !selected.covered || !window || !resource || hashKey(window.key) === hashKey(resource.windowKey)) return
    if (client.getQueryData(entryOptions.queryKey) !== resource) return
    const retained = entry.state.get()
    if (!retained.covered || retained.window !== window) return
    const landing = client.getQueryData<MessageWindowData>(resource.windowKey)
    const target = Math.max(0, ...(landing?.pages.map(page => page.latestSeq ?? 0) ?? []))
    const owner = client.getQueryCache().find({ queryKey: entryOptions.queryKey, exact: true })
    const controller = new AbortController()
    void reconcileWindow(client, {
      kind: input.serverId === null ? "dm" : "channel", scopeId: input.channelId, serverId: input.serverId ?? undefined,
    }, window.key, target, undefined, owner ? { query: owner, signal: controller.signal } : undefined).catch(() => undefined)
    return () => controller.abort()
  }, [canRead, client, entryOptions.queryKey, input.channelId, input.serverId, resource, window, presented, selected.covered, entry.state, query.isFetching])
  const activeQuery = needsCanonicalWindow ? canonicalQuery : query
  const refetch = activeQuery.refetch
  const retry = useCallback(() => refetch({ cancelRefetch: false }), [refetch])
  return { ...activeQuery, intent, resource, scope, canonical, canRead, windowReady, window, snapshot, targetCovered, revoked, denied, anchorMissing,
    initialPositionPending: !targetCovered,
    initialPositionMessageId: targetCovered && localPosition && snapshot && snapshot.lastReadSeq < localPosition.seq ? localPosition.messageId : null,
    isPending: !!target && !window && !denied && !anchorMissing && !activeQuery.isError && activeQuery.errorUpdatedAt === 0,
    failed: !window && activeQuery.errorUpdatedAt > 0,
    retry, retrying: activeQuery.isFetching,
  }
}
