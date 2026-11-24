"use client"

import { useConversationPresentation } from "@/contexts/view-activity"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { CancelledError, hashKey, useInfiniteQuery, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import { useConversationEntry } from "./use-conversation-entry"
import { useConversationTimeline } from "./use-conversation-timeline"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useMessageWindowProjection } from "@/lib/community-db/projections"
import { useMessageOverlayIds } from "@/stores/community/message-stream"
import type { MessageScope } from "@/lib/community/message-stream"
import { mergeTimelinePages, type TimelineCanonicalPage } from "@/lib/community/conversation-timeline"
import { messagePageForReading, messagePageNeighbors, messageWindowOptions, viewportFillFetchMeta, type InitialMessageWindow, type MessageWindowData } from "@/lib/community/message-window"
import { contiguousWindowLatestSeq, conversationEntryOptions, deriveLocalConversationNewBoundary, findCachedMessageWindowContaining, knownConversationLatestSeq, type ConversationEntryResource, type findConversationEntryWindow } from "@/lib/community/conversation-entry"
import type { Msg } from "@/lib/community/models/message"
import type { MessageNeighborhood, MessagePositionState, MessageRequest, MessageRequestResult } from "@/lib/community/message-position"
import { ConversationReadTimeoutError, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { isFailedMessageRepair, messageReconcileOptions, reconcileWindow } from "@/lib/community/message-reconcile"
import type { ConversationListScope } from "@/lib/community/conversation-qualification"
import { useCommunityOnlineAccount } from "./community-origin"

export { channelMessagesQueryFn } from "@/lib/community/message-window"
export type { MessagesPage, MessagesPageParam } from "@/lib/community/models/message"

export function messageMatchesTag(message: Msg, tag?: string | null): boolean {
  return !tag || message.thread?.tags?.includes(tag) === true
}

/**
 * Merge all pages into a single chronological ASC list, deduping by id.
 * Extracted so tests can drive the reducer without spinning up a full hook.
 *
 * Pages arrive out of order — the initial page may be an anchor window in the
 * middle of history, then older pages append below and newer pages prepend
 * above. Sort once at the end so the visible order is always correct
 * regardless of fetch sequence. Bounded by loaded rows (typically < 500) —
 * O(n log n) is fine here.
 */
export function mergeMessagesPages<T extends { id: string; seq?: number; createdAt?: string }>(pages: Array<{ messages: T[] }>): T[] {
  return mergeTimelinePages(pages)
}

const INITIAL_ENTRY_ERROR = new Error("Could not load this conversation")

type MessagesOpts = {
  viewerUserId?: string
  enabled?: boolean
  tag?: string | null
  anchorMessageId?: string | null
}

type ChannelMessagesOpts = MessagesOpts & { serverId: string }
type DisplayWindow = NonNullable<ReturnType<typeof findConversationEntryWindow>>
type PresentSelection = { attempt: number; pending: boolean; window: DisplayWindow | null; version: number; error: Error | null; request: MessageRequest | null; reading: { query: object; key: string } | null }

export function useMessages(channelId: string | null, opts: ChannelMessagesOpts) {
  return useMessageSurface(channelId, opts, opts.serverId)
}

export function useDmMessages(dmId: string | null, opts?: MessagesOpts) {
  return useMessageSurface(dmId, opts, null)
}

function useMessageSurface(channelId: string | null, opts: MessagesOpts | undefined, serverId: string | null) {
  const client = useQueryClient()
  const presented = useConversationPresentation()
  const onlineAccount = useCommunityOnlineAccount()
  const tag = opts?.tag ?? null
  const anchorMessageId = opts?.anchorMessageId ?? null
  const entry = useConversationEntry(channelId && opts?.enabled !== false ? { channelId, serverId, anchorMessageId, tag } : null)
  const proof = entry.scope?.proof
  const positionScope = useMemo<ConversationListScope | undefined>(() => entry.canRead && proof
    ? { proof, tag } : undefined, [entry.canRead, proof, tag])
  const viewKey = hashKey([channelId, serverId, anchorMessageId, tag, proof?.accountEpoch ?? -1, proof?.accessEpoch ?? -1,
    channelId ? proof?.channelScopes.get(channelId)?.generation ?? 0 : 0])
  const present = useMemo(() => ({ viewKey, intent: entry.intent,
    state: createStore<PresentSelection>({ attempt: 0, pending: false, window: null, version: 0, error: null, request: null, reading: null }),
  }), [viewKey, entry.intent]).state
  const selection = useSelector(present, (state) => state)
  const retries = useMemo(() => ({ client, channelId, serverId, anchorMessageId, tag, intent: entry.intent,
    state: createStore<{ attempt: object | null; pending: boolean; error: Error | null }>({ attempt: null, pending: false, error: null }),
  }), [client, channelId, serverId, anchorMessageId, tag, entry.intent]).state
  const retrySelection = useSelector(retries, state => state)
  const positionEntry = useMemo(() => retrySelection.attempt ? { intent: entry.intent, retry: retrySelection.attempt } : entry.intent,
    [entry.intent, retrySelection.attempt])
  const selectedWindow = entry.canRead ? selection.window ?? entry.window : null
  const enabled = !!channelId && !!selectedWindow && entry.canRead
  const initial: InitialMessageWindow = selectedWindow?.initial ?? { mode: "newest" }
  const options = messageWindowOptions(client, enabled ? channelId : "__none__", initial, tag)
  const queryKey = selectedWindow?.key ?? options.queryKey
  const query = useInfiniteQuery({ ...options, queryKey, staleTime: Infinity, enabled: enabled && presented, subscribed: enabled })
  const repairKey: QueryKey = [...queryKey, "reconcile"]
  const repairOptions = client.getQueryCache().find<{ latestSeq: number }>({ queryKey: repairKey, exact: true })?.options
  const repair = useQuery({ ...(repairOptions?.queryFn ? repairOptions : messageReconcileOptions(client, {
    kind: serverId === null ? "dm" : "channel", scopeId: channelId ?? "__none__", serverId: serverId ?? undefined,
  }, queryKey)),
    queryKey: repairKey, enabled: false, subscribed: enabled, notifyOnChangeProps: "all" })
  const repairQuery = client.getQueryCache().find({ queryKey: repairKey, exact: true })
  const originalQuery = client.getQueryCache().find<MessageWindowData>({ queryKey, exact: true })
  const owner = useMemo(() => ({ present, retries, query: originalQuery, enabled: enabled && presented }), [present, retries, originalQuery, enabled, presented])
  const committed = useRef<typeof owner | null>(null)
  const committedWindowReady = useRef(false)
  const committedUnderfillReady = useRef(false)
  const committedNewReady = useRef(false)
  useLayoutEffect(() => {
    committed.current = owner
    return () => { if (committed.current === owner) committed.current = null }
  }, [owner])
  const scope = useMemo<MessageScope>(() => serverId === null ? { kind: "dm", id: channelId ?? "__none__" }
    : { kind: "channel", id: channelId ?? "__none__", serverId }, [channelId, serverId])
  const overlay = useMessageOverlayIds(scope)
  const references = useMemo(() => query.data ? mergeMessagesPages(query.data.pages) : [], [query.data])
  const ids = useMemo(() => references.map((message) => message.id), [references])
  const projection = useMessageWindowProjection(entry.canRead ? channelId : null, ids, overlay.liveIds)
  const canonicalById = useMemo(() => new Map((projection.canonicalMessages ?? []).flatMap((message) =>
    typeof message.seq === "number" ? [[message.id, { ...message, seq: message.seq }] as const] : [])), [projection.canonicalMessages])
  const presentationResources = useMemo(() => new Map([...projection.relatedMessages.map(message => [message.id, message] as const), ...canonicalById]), [canonicalById, projection.relatedMessages])
  const missingCanonical = ids.some(id => !canonicalById.has(id))
  const projectionFailed = projection.status === "error"
  const selectedWindowReady = entry.windowReady && !!query.data && projection.canonicalMessages !== undefined && !missingCanonical && !projectionFailed
  useLayoutEffect(() => { committedWindowReady.current = selectedWindowReady }, [selectedWindowReady])
  const [projectionFailure, setProjectionFailure] = useState<{ window: object; attempt: object | null; viewKey: string } | null>(null)
  useEffect(() => {
    if (!entry.canRead || !query.data || !missingCanonical || projectionFailed) return
    const window = query.data, attempt = retrySelection.attempt
    const controller = new AbortController()
    void withConversationReadDeadline(controller.signal, () => new Promise<never>(() => {})).catch(error => {
      if (!controller.signal.aborted && error instanceof ConversationReadTimeoutError) setProjectionFailure({ window, attempt, viewKey })
    })
    return () => controller.abort()
  }, [entry.canRead, missingCanonical, projectionFailed, query.data, retrySelection.attempt, viewKey])
  const canonicalBase = useMemo(() => projection.windowIds.flatMap((id) => {
    const message = canonicalById.get(id)
    return message ? [message] : []
  }).sort((left, right) => left.seq - right.seq), [projection.windowIds, canonicalById])
  const timelinePages = useMemo<TimelineCanonicalPage[]>(() => (
    (query.data?.pages ?? []).map((page) => ({
      messages: page.messages.flatMap((reference) => {
        const canonical = canonicalById.get(reference.id)
        return canonical ? [canonical] : []
      }),
      hasMoreOlder: page.hasMoreOlder,
      hasMore: page.hasMore,
      hasMoreNewer: page.hasMoreNewer,
      olderCursor: page.olderCursor,
      cursor: page.cursor,
      newerCursor: page.newerCursor,
      latestSeq: page.latestSeq,
    }))
  ), [canonicalById, query.data?.pages])
  const error = query.error ?? entry.error
  const windowAvailable = !!selectedWindow && query.data !== undefined
  const projectionError = projectionFailed || missingCanonical && !!projectionFailure && projectionFailure.window === query.data
    && projectionFailure.attempt === retrySelection.attempt && projectionFailure.viewKey === viewKey ? INITIAL_ENTRY_ERROR : null
  const initialLoadError = windowAvailable ? projectionError : retrySelection.error ?? error ?? (entry.failed ? INITIAL_ENTRY_ERROR : null)
  const repairError = repairQuery && isFailedMessageRepair(client, repairQuery) ? repair.error : null
  const targetLoadError = windowAvailable && !selection.window && !entry.isFetching && entry.error?.name !== "AbortError"
    ? (!entry.targetCovered || entry.newBoundary === undefined ? entry.error : null) ?? repairError : null
  const timeline = useConversationTimeline({
    client,
    channelId,
    scope,
    viewerUserId: opts?.viewerUserId ?? proof?.viewerId,
    tag,
    canRead: entry.canRead,
    revoked: entry.revoked,
    denied: entry.denied,
    canonicalBase,
    presentationResources,
    overlay,
    pages: timelinePages,
    readSnapshot: entry.snapshot,
    newBoundary: entry.newBoundary,
    targetCovered: entry.targetCovered || !!selection.window,
    reconciling: entry.isFetching || query.isFetching || repair.isFetching,
    initialLoadError,
    targetLoadError,
  })
  const messages = timeline.messages
  const windowLatestSeq = Math.max(0, ...(query.data?.pages.map((page) => page.latestSeq ?? 0) ?? []))
  const contiguousTail = channelId && !tag
    ? contiguousWindowLatestSeq(client, { channelId, serverId }, query.data)
    : { latestSeq: windowLatestSeq, liveGap: false }
  const latestSeq = Math.max(windowLatestSeq, contiguousTail.latestSeq)
  const landingWindow = entry.resource ? client.getQueryData<MessageWindowData>(entry.resource.windowKey) : undefined
  const landingLatestSeq = Math.max(0, ...(landingWindow?.pages.map(page => page.latestSeq ?? 0) ?? []))
  const repairTarget = client.getQueryData<number>([...queryKey, "reconcile-target"]) ?? 0
  const coveredLatestSeq = Math.max(0, ...canonicalBase.map(message => message.seq))
  const readSnapshotFetching = !entry.snapshot || !entry.targetCovered && !selection.window || entry.isPending || ids.some(id => !canonicalById.has(id))
    || repairTarget > coveredLatestSeq
    || !anchorMessageId && !tag && (landingLatestSeq > latestSeq
      || entry.isFetching && !!channelId && (contiguousTail.liveGap || knownConversationLatestSeq(client, channelId) > latestSeq))
  const pages = query.data?.pages ?? []
  const oldest = pages.at(-1)
  const newest = pages[0]
  const hasMoreOlder = (oldest?.hasMoreOlder ?? oldest?.hasMore) ?? false
  const historyStartKnown = !!selectedWindow && (oldest?.hasMoreOlder ?? oldest?.hasMore) === false
  const hasMoreNewer = newest?.hasMoreNewer ?? false
  const olderCursor = oldest?.olderCursor ?? oldest?.cursor
  const firstReference = oldest?.messages[0]
  const firstRow = firstReference && canonicalById.get(firstReference.id)
  const underfillWindowReady = serverId === null
    ? entry.displayWindowReady
    : entry.windowReady && entry.targetCovered && !hasMoreNewer
  const underfillReady = initial.mode === "newest" && !tag && onlineAccount && presented && underfillWindowReady
    && !missingCanonical && !projectionFailed && query.hasNextPage && !query.isFetching && !repair.isFetching
    && !!firstRow?.createdAt && olderCursor === `${firstRow.createdAt}|${firstRow.id}`
  useLayoutEffect(() => { committedUnderfillReady.current = underfillReady }, [underfillReady])
  const reading = selection.reading?.query === originalQuery ? selection.reading : null
  const messageNeighborhood = useMemo<MessageNeighborhood | undefined>(() => reading && query.data
    ? { page: reading, ...messagePageNeighbors(query.data, reading.key) } : undefined, [query.data, reading])
  const onReadingMessage = useCallback((messageId: string) => {
    const original = committed.current
    if (!original?.enabled || original !== owner || !original.query || !committedWindowReady.current) return
    const data = original.query.state.data as MessageWindowData | undefined
    if (!data) return
    const current = present.get().reading
    const key = messagePageForReading(data, messageId, current?.query === original.query ? current.key : undefined)
    if (!key || current?.query === original.query && current.key === key) return
    present.setState(state => ({ ...state, reading: { query: original.query!, key } }))
  }, [owner, present])
  const fetchPage = useCallback((direction: "older" | "newer", underfill = false): MessageRequest => {
    const original = committed.current
    if (!channelId || !original?.enabled || !original.query || original !== owner
      || (underfill ? !committedUnderfillReady.current || original.query.state.data !== query.data
        || original.query.state.fetchStatus !== "idle" || repairQuery?.state.fetchStatus === "fetching"
        : !committedWindowReady.current)) return { accepted: false }
    if (direction === "older" ? !query.hasNextPage || query.isFetchingNextPage : !query.hasPreviousPage || query.isFetchingPreviousPage) return { accepted: false }
    const token = captureChannelMetadataToken(client, channelId)
    const isCurrent = () => committed.current === original && isChannelMetadataTokenCurrent(token)
      && client.getQueryCache().get(original.query!.queryHash) === original.query
    const fetch = async (): Promise<MessageRequestResult> => {
      if (underfill) {
        const window = await original.query!.fetch(undefined, { cancelRefetch: false, meta: viewportFillFetchMeta })
        return isCurrent() ? { status: "success", window } : { status: "retired" }
      }
      while (isCurrent() && original.query!.state.fetchStatus !== "idle") await query.refetch({ cancelRefetch: false })
      if (!isCurrent()) return { status: "retired" }
      const result = direction === "older" ? await query.fetchNextPage({ cancelRefetch: false })
        : await query.fetchPreviousPage({ cancelRefetch: false })
      if (!isCurrent()) return { status: "retired" }
      return result.isError || !result.data ? { status: "error" } : { status: "success", window: result.data }
    }
    return { accepted: true, completed: fetch().catch(error => ({ status: error instanceof CancelledError ? "retired" : "error" })) }
  }, [channelId, client, owner, query, repairQuery])
  const fetchOlder = useCallback(() => fetchPage("older"), [fetchPage])
  const fillHistory = useCallback(() => fetchPage("older", true), [fetchPage])
  const fetchNewer = useCallback(() => fetchPage("newer"), [fetchPage])
  const jumpToPresent = useCallback((): MessageRequest => {
    const original = committed.current
    if (!channelId || !original?.enabled || original !== owner || !committedWindowReady.current || present.get().pending) return { accepted: false }
    const token = captureChannelMetadataToken(client, channelId)
    const tail = messageWindowOptions(client, channelId, { mode: "newest" }, tag)
    const captured = client.getQueryCache().build<unknown, Error, unknown>(client, { queryKey: tail.queryKey })
    present.setState((state) => ({ ...state, attempt: state.attempt + 1, pending: true, error: null }))
    const attempt = present.get().attempt
    const isCurrent = () => committed.current === original && isChannelMetadataTokenCurrent(token)
      && client.getQueryCache().get(captured.queryHash) === captured
    const completed = client.infiniteQuery({ ...tail, staleTime: 0, select: undefined }).then((data): MessageRequestResult => {
      if (!isCurrent()) return { status: "retired" }
      present.setState((state) => ({ ...state, pending: false, version: attempt,
        window: { key: tail.queryKey, initial: { mode: "newest" }, tag } }))
      return { status: "success", window: data, windowState: window => {
        const current = committed.current
        if (!current?.enabled || current.present !== present || present.get().attempt !== attempt || !isChannelMetadataTokenCurrent(token)
          || client.getQueryCache().get(captured.queryHash) !== captured) return "retired"
        if (current.query === captured) return window === captured.state.data ? "ready" : "pending"
        return current.query === original.query && !!original.query
          && client.getQueryCache().get(original.query.queryHash) === original.query ? "pending" : "retired"
      } }
    }, (error: unknown) => {
      if (!isCurrent()) return { status: "retired" } as const
      present.setState((state) => ({ ...state, pending: false, error: error instanceof Error ? error : new Error("Could not load recent messages") }))
      return { status: "error" } as const
    })
    const request: MessageRequest = { accepted: true, completed }
    present.setState(state => ({ ...state, request }))
    return request
  }, [channelId, client, owner, present, tag])
  const loadNewTarget = useCallback((id: string): MessageRequest => {
    const original = committed.current
    if (!channelId || !original?.enabled || original !== owner || !committedNewReady.current || present.get().pending) return { accepted: false }
    if ((references.some(message => message.id === id) || messages.some(message => message.id === id)) && query.data) {
      return { accepted: true, completed: Promise.resolve({ status: "success", window: query.data }) }
    }
    if (entry.scope) {
      const cachedMatch = findCachedMessageWindowContaining(client, { channelId, serverId, tag }, entry.scope, id)
      if (cachedMatch) {
        present.setState(state => ({ ...state, attempt: state.attempt + 1, pending: false, error: null, window: cachedMatch.window }))
        return { accepted: true, completed: Promise.resolve({ status: "success", window: cachedMatch.data }) }
      }
    }
    const token = captureChannelMetadataToken(client, channelId)
    const initial = { mode: "anchor" as const, anchor: id }
    const anchored = messageWindowOptions(client, channelId, initial, tag)
    const unqualifiedCached = client.getQueryData(anchored.queryKey) !== undefined
    const captured = client.getQueryCache().build<unknown, Error, unknown>(client, { queryKey: anchored.queryKey })
    present.setState(state => ({ ...state, attempt: state.attempt + 1, pending: true, error: null }))
    const attempt = present.get().attempt
    let cancelled = false
    const isCurrent = () => !cancelled && present.get().attempt === attempt && committed.current === original && isChannelMetadataTokenCurrent(token)
      && client.getQueryCache().get(captured.queryHash) === captured
    const completed = client.infiniteQuery({ ...anchored, ...(unqualifiedCached ? { staleTime: 0 } : {}), select: undefined }).then((data): MessageRequestResult => {
      if (!isCurrent()) return { status: "retired" }
      if (!data.pages.some(page => page.messages.some(message => message.id === id))) {
        present.setState(state => ({ ...state, pending: false }))
        return { status: "missing" }
      }
      present.setState(state => ({ ...state, pending: false, window: { key: anchored.queryKey, initial, tag } }))
      return { status: "success", window: data }
    }, (error: unknown): MessageRequestResult => {
      if (!isCurrent()) return { status: "retired" }
      present.setState(state => ({ ...state, pending: false }))
      return { status: typeof error === "object" && error !== null && "status" in error && (error.status === 403 || error.status === 404) ? "missing" : "error" }
    })
    return { accepted: true, completed, cancel: () => {
      cancelled = true
      if (committed.current === original && present.get().attempt === attempt) present.setState(state => ({ ...state, pending: false }))
    } }
  }, [channelId, client, entry.scope, messages, owner, present, query.data, references, serverId, tag])
  const readNewBoundary = useCallback(async (afterSeq: number) => {
    const original = committed.current
    if (!channelId || !original?.enabled || original !== owner || !committedNewReady.current) return
    const token = captureChannelMetadataToken(client, channelId)
    const registry = getCommunityDbRegistry(client)
    const wsConnected = registry?.runtime.ws.get().connectionStatus === "connected"
    if (wsConnected && entry.scope && original.query && !entry.isFetching && !query.isFetching && !repair.isFetching) {
      const local = deriveLocalConversationNewBoundary(client, { channelId, serverId, tag }, entry.scope, original.query.queryKey, afterSeq)
      if (local?.tailComplete) {
        return { boundary: local.boundary, latestSeq: local.latestSeq }
      }
    }
    const entryOpts = conversationEntryOptions(client, { channelId, serverId, tag, preferTail: true, newAfterSeq: afterSeq })
    const initial = typeof entryOpts.initialData === "function" ? entryOpts.initialData() : entryOpts.initialData
    const existing = client.getQueryData<ConversationEntryResource>(entryOpts.queryKey) ?? initial
    const liveMaxSeq = Math.max(
      latestSeq,
      coveredLatestSeq,
      ...overlay.liveIds.map(id => registry?.collections.messages.get(id)?.seq ?? 0),
    )
    const staleNullBoundary = !!existing
      && isChannelMetadataTokenCurrent(existing.proof)
      && existing.newBoundaryAtEntry.target === null
      && liveMaxSeq > existing.latestSeqAtEntry
    const resource = await client.query(staleNullBoundary ? { ...entryOpts, staleTime: 0 } : entryOpts)
    if (committed.current !== original || !isChannelMetadataTokenCurrent(token)) return
    return { boundary: resource.newBoundaryAtEntry, latestSeq: resource.latestSeqAtEntry }
  }, [channelId, client, coveredLatestSeq, entry.isFetching, entry.scope, latestSeq, overlay.liveIds, owner, query.isFetching, repair.isFetching, serverId, tag])
  const loading = !!channelId && (windowAvailable ? projection.canonicalMessages === undefined : !initialLoadError && !entry.denied && !entry.anchorMissing)
  const entryWindow = entry.window, retryEntry = entry.retry, refetchWindow = query.refetch
  const retryInitialLoad = useCallback(() => {
    if (!channelId || committed.current?.retries !== retries || retries.get().pending) return
    const attempt = {}
    const token = channelId ? captureChannelMetadataToken(client, channelId) : null
    const current = () => committed.current?.retries === retries && retries.get().attempt === attempt && !!token && isChannelMetadataTokenCurrent(token)
    retries.setState(() => ({ attempt, pending: true, error: null }))
    const request = repairError ? reconcileWindow(client, {
      kind: serverId === null ? "dm" : "channel", scopeId: channelId, serverId: serverId ?? undefined,
    }, queryKey).then(() => ({ error: null }), error => ({ error: error instanceof Error ? error : new Error("Could not repair this message window") }))
      : entryWindow && entry.targetCovered && entry.newBoundary !== undefined ? refetchWindow({ cancelRefetch: false }) : retryEntry()
    void request.then(result => {
      if (!current()) return
      retries.setState(() => ({ attempt, pending: false, error: result.error }))
    })
  }, [channelId, client, entryWindow, entry.targetCovered, entry.newBoundary, queryKey, repairError, retryEntry, refetchWindow, retries, serverId])
  const targetPositionDataState: MessagePositionState = retrySelection.pending ? "pending"
    : initialLoadError || targetLoadError || retrySelection.error || entry.denied || !windowAvailable && entry.anchorMissing && !entry.isFetching ? "error"
      : !windowAvailable || loading || missingCanonical || !!anchorMessageId && !entry.targetCovered && !selection.window && !entry.anchorMissing ? "pending"
        : messages.length ? "ready" : "empty"
  // Snapshot and coverage still qualify reading and pagination, independently of cached display.
  const positionDataState: MessagePositionState = targetPositionDataState === "error"
    && (!targetLoadError || !anchorMessageId && !entry.targetCovered && !entry.retainedWindow && !selection.window) ? "error"
    : !windowAvailable || !entry.snapshot || loading || readSnapshotFetching || retrySelection.pending ? "pending"
      : messages.length ? "ready" : "empty"
  useLayoutEffect(() => { committedNewReady.current = entry.canRead && windowAvailable && !loading && !missingCanonical
    && !initialLoadError && !targetLoadError && positionDataState === "ready" },
  [entry.canRead, windowAvailable, loading, missingCanonical, initialLoadError, targetLoadError, positionDataState])
  return {
    ...query,
    messages, canonicalMessages: canonicalBase, canonicalById,
    latestSeq, hasMoreOlder, hasMoreNewer, historyStartKnown, hasMore: hasMoreOlder,
    isLoading: loading, isPending: loading, isError: !!initialLoadError && !query.data,
    error, initialLoadError, targetLoadError, isFetching: entry.isFetching || query.isFetching,
    olderLoadError: query.isFetchNextPageError ? query.error : null,
    newerLoadError: query.isFetchPreviousPageError ? query.error : null,
    presentPending: selection.pending, presentError: selection.error,
    isFetchingOlder: query.isFetchingNextPage,
    isFetchingNewer: query.isFetchingPreviousPage || selection.pending,
    fetchOlder, fillHistory: underfillReady ? fillHistory : undefined, fetchNewer, messageNeighborhood, onReadingMessage, jumpToPresent, loadNewTarget, readNewBoundary, newBoundary: entry.newBoundary, retiredNewTargetId: entry.retiredNewTargetId, presentVersion: selection.version, presentRequest: selection.request,
    anchorReconciled: entry.targetCovered || !!selection.window,
    navigationBlocked: !selectedWindowReady,
    readSnapshot: entry.snapshot, readSnapshotFetching,
    initialDisplayReady: entry.displayWindowReady && windowAvailable && !loading && !missingCanonical && !initialLoadError,
    preserveInitialPresentation: !!retrySelection.attempt && windowAvailable && (!!anchorMessageId || entry.targetCovered || entry.retainedWindow),
    initialPositionKnown: windowAvailable && entry.snapshot !== null && !loading && !missingCanonical && !initialLoadError && !retrySelection.pending && !entry.initialPositionPending,
    initialPositionMessageId: entry.initialPositionMessageId, positionEntry, positionScope, positionDataState, targetPositionDataState, messageWindow: query.data,
    onUserTakeover: entry.retainWindow,
    retryInitialLoad, retryingInitialLoad: entry.isFetching || query.isFetching,
    entryCanRead: entry.canRead, entryDenied: entry.denied, entryAnchorMissing: entry.anchorMissing,
  }
}
