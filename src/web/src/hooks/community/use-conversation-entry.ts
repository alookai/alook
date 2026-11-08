"use client"

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { hashKey, useIsRestoring, useQuery, useQueryClient } from "@tanstack/react-query"
import { useConversationActivity, useConversationPresentation } from "@/contexts/view-activity"
import { CommunityRouteContext } from "@/contexts/community/route-frame"
import { channelHref, normalizeCommunityHref } from "@/lib/community/community-route"
import { communityMessageProfileIds, type CommunityReadStateResource } from "@alook/shared"
import { useCanonicalMessagesById, useCanonicalProfilesProjection, useChannelReadStateProjection, useChannelRosterRows, useRouteChannelProjection } from "@/lib/community-db/projections"
import { canonicalMessageResource } from "@/lib/community-db/resources"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCommunityRuntime } from "@/stores/community/runtime"
import { conversationListScopeKey, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import { actionAttributes, currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { emitTelemetry, telemetryGeneration } from "@/lib/observability/telemetry"
import {
  assessConversationScope, conversationEntryOptions, currentConversationReadState, findConversationDisplayWindow, findConversationEntryWindow, getQualifiedConversationEntry, getQualifiedConversationScope,
  type ConversationEntryResource, type ConversationEntryTarget,
} from "@/lib/community/conversation-entry"
import { messageWindowIdentity, type MessageWindowData } from "@/lib/community/message-window"
import { communityKeys } from "@/lib/query-keys"
import { reconcileWindow } from "@/lib/community/message-reconcile"
import { isConversationAccessError, isConversationAnchorMissingError } from "@/lib/community/conversation-read"

type EntryWindow = NonNullable<ReturnType<typeof findConversationEntryWindow>>

export function useConversationResource(target: ConversationEntryTarget | null, intent?: { href: string; resume?: boolean } | null, consumer: "metadata" | "messages" | "forum" = "metadata", networkEnabled = true) {
  const client = useQueryClient()
  const restoring = useIsRestoring()
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
  const preferTail = target?.preferTail !== false
  const cutoffScope = hashKey([channelId, serverId, anchorMessageId, tag, preferTail, accountEpoch, accessEpoch, generation, parentGeneration, lifetime])
  const providedCutoff = target?.newAfterSeq ?? null
  const qualifiedPointer = target && getQualifiedConversationScope(client, target) ? currentConversationReadState(client, channelId) : undefined
  const captureCutoff = () => {
    if (providedCutoff !== null) return providedCutoff
    const qualification = { accountEpoch, accessEpoch, channelGeneration: generation }
    const pending = client.getQueryCache().findAll({ queryKey: communityKeys.conversationEntries(channelId) }).find(query => {
      if (query.state.fetchStatus !== "fetching") return false
      const candidate = query.queryKey[communityKeys.conversationEntries(channelId).length] as Parameters<typeof communityKeys.conversationEntry>[1] | undefined
      return candidate && hashKey(communityKeys.conversationEntry(channelId, { serverId, anchorMessageId, tag, preferTail, newAfterSeq: candidate.newAfterSeq }, qualification)) === query.queryHash
    })
    if (pending) return (pending.queryKey[communityKeys.conversationEntries(channelId).length] as NonNullable<Parameters<typeof communityKeys.conversationEntry>[1]>).newAfterSeq ?? null
    return qualifiedPointer?.lastReadSeq ?? null
  }
  const [entryCutoff, setEntryCutoff] = useState(() => ({ client, cutoffScope, intent, providedCutoff, restoring, afterSeq: captureCutoff() }))
  let currentCutoff = entryCutoff
  if (entryCutoff.client !== client || entryCutoff.cutoffScope !== cutoffScope || entryCutoff.intent !== intent || entryCutoff.providedCutoff !== providedCutoff || entryCutoff.restoring !== restoring) {
    currentCutoff = { client, cutoffScope, intent, providedCutoff, restoring, afterSeq: captureCutoff() }
    setEntryCutoff(currentCutoff)
  }
  const newAfterSeq = currentCutoff.afterSeq
  const enabled = target !== null && networkEnabled && !restoring
  const baseInput = useMemo(() => ({ channelId, serverId, anchorMessageId, tag, preferTail, newAfterSeq }), [channelId, serverId, anchorMessageId, tag, preferTail, newAfterSeq])
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
  const input = baseInput
  const request = useMemo(() => ({ qualification, options: conversationEntryOptions(client, input) }), [client, input, qualification])
  const options = request.options
  const entryHash = hashKey(options.queryKey)
  const restoreSubscriptionEnabled = restoring && target !== null
  const subscribeRestoredEntry = useCallback((notify: () => void) => restoreSubscriptionEnabled
    ? client.getQueryCache().subscribe(event => { if (event.query.queryHash === entryHash) notify() }) : () => undefined,
  [client, entryHash, restoreSubscriptionEnabled])
  const readRestoredEntry = useCallback(() => restoreSubscriptionEnabled ? client.getQueryData<ConversationEntryResource>(options.queryKey) : undefined,
    [client, options.queryKey, restoreSubscriptionEnabled])
  const restoredEntry = useSyncExternalStore(subscribeRestoredEntry, readRestoredEntry, readRestoredEntry)
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
    : restoredEntry && isChannelMetadataTokenCurrent(restoredEntry.proof) ? restoredEntry
    : fallback.data && isChannelMetadataTokenCurrent(fallback.data.proof) ? fallback.data
      : cachedResource && isChannelMetadataTokenCurrent(cachedResource.proof) ? cachedResource : undefined
  const readableScope = useMemo(() => scope ?? resource, [scope, resource])
  const qualified = !!target && !!canonical && !!readableScope && !revoked
    && canonical.id === channelId && canonical.serverId === serverId && !canonical.archived
  const refetch = query.refetch
  useEffect(() => { if (presented && enabled && verification.needed) void refetch({ cancelRefetch: false }) }, [refetch, verification, enabled, presented])
  useEffect(() => {
    if (!presented || restoring || !target || revoked || !query.data || isChannelMetadataTokenCurrent(query.data.proof) || query.isFetching || query.isError) return
    void client.invalidateQueries({ queryKey: options.queryKey, exact: true })
  }, [client, parentGeneration, options.queryKey, query.data, query.isFetching, query.isError, revoked, target, presented, restoring])
  const fallbackRefetch = fallback.refetch
  const retryVerification = useCallback(() => (anchorMissing ? fallbackRefetch : refetch)({ cancelRefetch: false }), [anchorMissing, fallbackRefetch, refetch])
  useEffect(() => {
    if (!presented || restoring || !target || !intent || revoked || !query.data || query.isFetching || query.isError) return
    if (client.getQueryData(options.queryKey) !== query.data) return
    const pointer = currentConversationReadState(client, channelId)
    const received = client.getQueryData<MessageWindowData>(query.data.windowKey)
    const anchor = input.anchorMessageId ?? pointer?.lastReadMessageId
    if (received?.pages?.some(page => Array.isArray(page.messages) && (anchor ? page.messages.some(message => message.id === anchor) : page.hasMoreNewer === false))) return
    if (pointer && !findConversationEntryWindow(client, input, query.data, pointer)) void client.query({ ...options, select: undefined }).catch(() => undefined)
  }, [client, channelId, intent, input, options, query.data, query.isFetching, query.isError, revoked, target, presented, restoring])
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
  const forumProfileIds: string[] = []
  const forum = client.getQueryData<{ pages: import("@/lib/community/forum-feed-window").ForumFeedPage[] }>(communityKeys.forumFeed(channelId, tag))
  if (Array.isArray(forum?.pages)) for (const page of forum.pages) if (Array.isArray(page?.threads)) for (const thread of page.threads) {
    if (!thread || typeof thread.id !== "string") continue
    if (Array.isArray(thread.participantIds)) forumProfileIds.push(...thread.participantIds.filter(id => typeof id === "string"))
    if (typeof thread.openerMessageId === "string") forumMessageIds.push(thread.openerMessageId)
    const child = getCommunityDbRegistry(client)?.collections.channels.get(thread.id)
    if (child?.firstMessageId) forumMessageIds.push(child.firstMessageId)
  }
  retainedIds.push(...forumMessageIds)
  const retainedMessages = useCanonicalMessagesById([...new Set(retainedIds)])
  const retainedResources = [...(retainedMessages?.keys() ?? [])].flatMap(id => {
    const registry = getCommunityDbRegistry(client)
    const parsed = registry && canonicalMessageResource(registry, registry.collections.messages.get(id))
    return parsed ? [parsed] : []
  })
  const retainedProfileIds = [...new Set([...communityMessageProfileIds(retainedResources), ...forumProfileIds])]
  const retainedProfiles = useCanonicalProfilesProjection(retainedProfileIds)
  const availableWindow = readableScope ? findConversationDisplayWindow(client, baseInput, readableScope) : undefined
  const availableGraph = availableWindow?.resources
  const requiredProfileIds = availableGraph?.profiles.map(profile => profile.id) ?? retainedProfileIds
  const profilesReady = requiredProfileIds.length === 0 || retainedProfiles.isReady && !retainedProfiles.isError
    && requiredProfileIds.every(id => retainedProfiles.resourceProfiles.has(id))
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
  // Local display must not wait for the read snapshot. Keep read-dependent admission separate.
  const displayWindowReady = qualified && cachedWindow !== undefined
  const windowReady = displayWindowReady && currentPointer !== undefined
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
  return { client, cachedResource, scope: readableScope, currentPointer, displayWindowReady, windowReady, displayWindow: cachedWindow, input, options, query, canonical, resource: qualified ? resource : undefined, canRead: qualified, revoked,
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
  const baseTarget = useMemo(() => target ? { ...target, preferTail: true } : null,
    [target?.channelId, target?.serverId, target?.anchorMessageId, target?.tag])
  const { client, cachedResource, scope, currentPointer, input, options: entryOptions, query, canonical, resource, canRead, displayWindowReady, windowReady, revoked, denied, anchorMissing } = useConversationResource(baseTarget, intent, "messages")
  const entryIdentity = hashKey([input, scope ? conversationListScopeKey({ proof: scope.proof, tag: input.tag }) : null])
  const createEntry = () => {
    const pointer = scope ? currentConversationReadState(client, input.channelId) : undefined
    const cachedScope = cachedResource ?? scope
    const covered = cachedScope ? findConversationEntryWindow(client, input, cachedScope, pointer) : undefined
    const window = covered ?? (cachedScope ? findConversationDisplayWindow(client, input, cachedScope) : undefined)
    const boundary = cachedResource && (query.isSuccess && !query.isFetching && query.data === cachedResource
      || input.newAfterSeq !== null && cachedResource.newBoundaryAtEntry.target !== null) && (input.newAfterSeq !== null
      ? cachedResource.newBoundaryAtEntry.afterSeq === input.newAfterSeq
      : cachedResource.readStateRevision >= (pointer?.observedRevision ?? -1)) ? cachedResource.newBoundaryAtEntry : undefined
    return { client, identity: entryIdentity, intent, knownRevision: pointer?.observedRevision ?? -1, state: createStore<{ snapshot: CommunityReadStateResource | null; window: EntryWindow | null; covered: boolean; retained: boolean; newBoundary: ConversationEntryResource["newBoundaryAtEntry"] | undefined }>({
      snapshot: pointer ?? null,
      window: window ?? null, covered: !!covered, retained: false, newBoundary: boundary,
    }) }
  }
  const [entry, setEntry] = useState(createEntry)
  if (entry.client !== client || entry.identity !== entryIdentity || entry.intent !== intent) setEntry(createEntry())
  const selected = useSelector(entry.state, (state) => state)
  const currentRevision = currentPointer?.observedRevision ?? -1
  const candidateResource = resource
  const candidatePointer = candidateResource && candidateResource.readStateRevision >= Math.max(entry.knownRevision, currentRevision)
    ? candidateResource.readStateAtEntry : scope ? currentConversationReadState(client, input.channelId) : undefined
  const candidateScope = candidateResource ?? scope
  const candidate = !selected.covered && candidateScope
    ? findConversationEntryWindow(client, input, candidateScope, candidatePointer) : undefined
  const display = !selected.window && candidateScope ? findConversationDisplayWindow(client, input, candidateScope) : undefined
  const window = canRead ? (selected.retained ? selected.window : candidate) ?? selected.window ?? candidate ?? display ?? null : null
  const snapshot = window ? (!selected.covered ? candidatePointer ?? selected.snapshot : selected.snapshot) ?? null : null
  const targetCovered = canRead && (selected.covered || !!candidate)
  const newBoundary = selected.newBoundary ?? (candidateResource
    && (query.isSuccess && !query.isFetching && query.data === candidateResource
      || input.newAfterSeq !== null && candidateResource.newBoundaryAtEntry.target !== null)
    && (input.newAfterSeq === null || candidateResource.newBoundaryAtEntry.afterSeq === input.newAfterSeq)
    ? candidateResource.newBoundaryAtEntry : undefined)
  useLayoutEffect(() => {
    if (!window || !snapshot || selected.window === window && selected.snapshot === snapshot && selected.covered === targetCovered && selected.newBoundary === newBoundary) return
    entry.state.setState(current => ({ ...current, window, snapshot, covered: targetCovered, newBoundary }))
  }, [window, snapshot, targetCovered, newBoundary, entry, selected])
  const retainWindow = useCallback(() => {
    if (!canRead || !window) return
    entry.state.setState(current => current.retained ? current : { ...current, window, retained: true })
  }, [canRead, entry, window])
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
  const activeQuery = query
  const refetch = activeQuery.refetch
  const retry = useCallback(() => refetch({ cancelRefetch: false }), [refetch])
  const refreshedBoundary = query.isSuccess && !query.isFetching && query.data && isChannelMetadataTokenCurrent(query.data.proof)
    ? query.data.newBoundaryAtEntry : undefined
  const retiredNewTargetId = newBoundary?.target && refreshedBoundary?.afterSeq === newBoundary.afterSeq
    && refreshedBoundary.target?.id !== newBoundary.target.id ? newBoundary.target.id : undefined
  return { ...activeQuery, intent, resource, scope, canonical, canRead, displayWindowReady, windowReady, window, snapshot, newBoundary: canRead ? newBoundary : undefined, retiredNewTargetId, targetCovered, revoked, denied, anchorMissing,
    initialPositionPending: !targetCovered,
    initialPositionMessageId: null,
    isPending: !!target && !window && !denied && !anchorMissing && !activeQuery.isError && activeQuery.errorUpdatedAt === 0,
    failed: !window && activeQuery.errorUpdatedAt > 0,
    retry, retrying: activeQuery.isFetching, retainWindow, retainedWindow: selected.retained,
  }
}
