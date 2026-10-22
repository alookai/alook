"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createStore, useSelector } from "@tanstack/react-store"
import { hashKey, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ApiRequestOptions } from "@/lib/api/client"
import { currentPageObservation, navigationForHref } from "@/lib/observability/context"
import { channelHref } from "@/lib/community/community-route"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/lib/community/conversation-qualification"
import { useConversationEntry } from "./use-conversation-entry"
import { useMessageWindowProjection } from "@/lib/community-db/projections"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { useMessageOverlayIds } from "@/stores/community/message-stream"
import { materializeMessageStream, type MessageScope } from "@/lib/community/message-stream"
import { messageWindowOptions, type InitialMessageWindow, type MessageWindowData } from "@/lib/community/message-window"
import { knownConversationLatestSeq, type findConversationEntryWindow } from "@/lib/community/conversation-entry"
import type { Msg } from "@/lib/community/models/message"
import type { MessagePositionState, MessageRequest, MessageRequestResult } from "@/lib/community/message-position"
import { ConversationReadTimeoutError, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { messageReconcileOptions } from "./community-ws/reconnect-messages"

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
  const all: T[] = []
  for (const p of pages) {
    for (const m of p.messages) all.push(m)
  }
  all.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined && a.seq !== b.seq) return a.seq - b.seq
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (ta !== tb) return ta - tb
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  const seen = new Set<string>()
  const out: T[] = []
  for (const m of all) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
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
type PresentSelection = { attempt: number; pending: boolean; window: DisplayWindow | null; version: number; error: Error | null; request: MessageRequest | null }

export function useMessages(channelId: string | null, opts: ChannelMessagesOpts) {
  return useMessageSurface(channelId, opts, opts.serverId)
}

export function useDmMessages(dmId: string | null, opts?: MessagesOpts) {
  return useMessageSurface(dmId, opts, null)
}

function useMessageSurface(channelId: string | null, opts: MessagesOpts | undefined, serverId: string | null) {
  const client = useQueryClient()
  const tag = opts?.tag ?? null
  const anchorMessageId = opts?.anchorMessageId ?? null
  const entry = useConversationEntry(channelId && opts?.enabled !== false ? { channelId, serverId, anchorMessageId, tag } : null)
  const proof = entry.resource?.proof
  const viewKey = hashKey([channelId, serverId, anchorMessageId, tag, proof?.accountEpoch ?? -1, proof?.accessEpoch ?? -1,
    channelId ? proof?.channelScopes.get(channelId)?.generation ?? 0 : 0])
  const present = useMemo(() => ({ viewKey, intent: entry.intent,
    state: createStore<PresentSelection>({ attempt: 0, pending: false, window: null, version: 0, error: null, request: null }),
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
  const observation = useCallback((): ApiRequestOptions["observation"] => {
    if (!channelId || typeof window === "undefined") return
    const expected = serverId === null ? `/c/me/${channelId}` : channelHref(serverId, channelId)
    if (window.location.pathname !== expected) return { page: undefined, reason: "unknown" }
    const action = navigationForHref(window.location.pathname + window.location.search)
    return action ? { action, reason: "foreground" } : { page: currentPageObservation(), reason: "background" }
  }, [channelId, serverId])
  const options = messageWindowOptions(client, enabled ? channelId : "__none__", initial, tag, { observation })
  const queryKey = selectedWindow?.key ?? options.queryKey
  const query = useInfiniteQuery({ ...options, queryKey, enabled, subscribed: enabled })
  const reconciliation = useQuery({ ...messageReconcileOptions(client, { kind: serverId === null ? "dm" : "channel", scopeId: channelId ?? "__none__", serverId: serverId ?? undefined }, queryKey), enabled: false, subscribed: enabled })
  const originalQuery = client.getQueryCache().find({ queryKey, exact: true })
  const owner = useMemo(() => ({ present, retries, query: originalQuery, enabled }), [present, retries, originalQuery, enabled])
  const committed = useRef<typeof owner | null>(null)
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
  const missingCanonical = ids.some(id => !canonicalById.has(id))
  const projectionFailed = projection.status === "error"
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
  useEffect(() => {
    if (channelId) getCommunityRuntime(client).messageStream.actions.dispatch(scope, { type: "baseChanged", messages: canonicalBase })
  }, [canonicalBase, channelId, client, scope])
  const messages = useMemo(() => entry.canRead ? materializeMessageStream(canonicalBase, overlay, canonicalById).filter((message) => messageMatchesTag(message, tag)) : [],
    [canonicalBase, canonicalById, overlay, entry.canRead, tag])
  const latestSeq = Math.max(0, ...(query.data?.pages.map((page) => page.latestSeq ?? 0) ?? []))
  const landingWindow = entry.resource ? client.getQueryData<MessageWindowData>(entry.resource.windowKey) : undefined
  const landingLatestSeq = Math.max(0, ...(landingWindow?.pages.map(page => page.latestSeq ?? 0) ?? []))
  const readSnapshotFetching = entry.isPending || ids.some(id => !canonicalById.has(id))
    || !anchorMessageId && !tag && (landingLatestSeq > latestSeq && (!reconciliation.isError || reconciliation.isFetching)
      || entry.isFetching && !!channelId && knownConversationLatestSeq(client, channelId) > latestSeq)
  const pages = query.data?.pages ?? []
  const oldest = pages.at(-1)
  const newest = pages[0]
  const hasMoreOlder = (oldest?.hasMoreOlder ?? oldest?.hasMore) ?? false
  const historyStartKnown = !!selectedWindow && (oldest?.hasMoreOlder ?? oldest?.hasMore) === false
  const hasMoreNewer = newest?.hasMoreNewer ?? false
  const fetchPage = useCallback((direction: "older" | "newer"): MessageRequest => {
    const original = committed.current
    if (!channelId || !original?.enabled || !original.query || original !== owner) return { accepted: false }
    if (direction === "older" ? !query.hasNextPage || query.isFetchingNextPage : !query.hasPreviousPage || query.isFetchingPreviousPage) return { accepted: false }
    const token = captureChannelMetadataToken(client, channelId)
    const isCurrent = () => committed.current === original && isChannelMetadataTokenCurrent(token)
      && client.getQueryCache().get(original.query!.queryHash) === original.query
    const fetch = async (): Promise<MessageRequestResult> => {
      while (isCurrent() && original.query!.state.fetchStatus !== "idle") await query.refetch({ cancelRefetch: false })
      if (!isCurrent()) return { status: "retired" }
      const result = direction === "older" ? await query.fetchNextPage({ cancelRefetch: false })
        : await query.fetchPreviousPage({ cancelRefetch: false })
      if (!isCurrent()) return { status: "retired" }
      return result.isError || !result.data ? { status: "error" } : { status: "success", window: result.data }
    }
    return { accepted: true, completed: fetch().catch(() => ({ status: "error" })) }
  }, [channelId, client, owner, query])
  const fetchOlder = useCallback(() => fetchPage("older"), [fetchPage])
  const fetchNewer = useCallback(() => fetchPage("newer"), [fetchPage])
  const jumpToPresent = useCallback((): MessageRequest => {
    const original = committed.current
    if (!channelId || !original?.enabled || original !== owner || present.get().pending) return { accepted: false }
    const token = captureChannelMetadataToken(client, channelId)
    const tail = messageWindowOptions(client, channelId, { mode: "newest" }, tag, { observation })
    const captured = client.getQueryCache().build<unknown, Error, unknown>(client, { queryKey: tail.queryKey })
    present.setState((state) => ({ ...state, attempt: state.attempt + 1, pending: true, error: null }))
    const attempt = present.get().attempt
    const isCurrent = () => committed.current === original && isChannelMetadataTokenCurrent(token)
      && client.getQueryCache().get(captured.queryHash) === captured
    const completed = client.infiniteQuery({ ...tail, staleTime: 0, select: undefined }).then((data): MessageRequestResult => {
      if (!isCurrent()) return { status: "retired" }
      present.setState((state) => ({ ...state, pending: false, version: attempt,
        window: { key: tail.queryKey, initial: { mode: "newest" }, tag } }))
      return { status: "success", window: data }
    }, (error: unknown) => {
      if (!isCurrent()) return { status: "retired" } as const
      present.setState((state) => ({ ...state, pending: false, error: error instanceof Error ? error : new Error("Could not load recent messages") }))
      return { status: "error" } as const
    })
    const request: MessageRequest = { accepted: true, completed }
    present.setState(state => ({ ...state, request }))
    return request
  }, [channelId, client, observation, owner, present, tag])
  const error = query.error ?? entry.error
  const windowAvailable = !!selectedWindow && query.data !== undefined
  const projectionError = projectionFailed || missingCanonical && !!projectionFailure && projectionFailure.window === query.data
    && projectionFailure.attempt === retrySelection.attempt && projectionFailure.viewKey === viewKey ? INITIAL_ENTRY_ERROR : null
  const initialLoadError = windowAvailable ? projectionError : retrySelection.error ?? error ?? (entry.failed ? INITIAL_ENTRY_ERROR : null)
  const loading = !!channelId && (windowAvailable ? projection.canonicalMessages === undefined : !initialLoadError && !entry.denied && !entry.anchorMissing)
  const entryWindow = entry.window, retryEntry = entry.retry, refetchWindow = query.refetch
  const retryInitialLoad = useCallback(() => {
    if (committed.current?.retries !== retries || retries.get().pending) return
    const attempt = {}
    const token = channelId ? captureChannelMetadataToken(client, channelId) : null
    const current = () => committed.current?.retries === retries && retries.get().attempt === attempt && !!token && isChannelMetadataTokenCurrent(token)
    retries.setState(() => ({ attempt, pending: true, error: null }))
    const request = entryWindow ? refetchWindow({ cancelRefetch: false }) : retryEntry()
    void request.then(result => {
      if (!current()) return
      retries.setState(() => ({ attempt, pending: false, error: result.error }))
    })
  }, [channelId, client, entryWindow, retryEntry, refetchWindow, retries])
  const positionDataState: MessagePositionState = retrySelection.pending ? "pending"
    : initialLoadError || retrySelection.error || entry.denied || !windowAvailable && entry.anchorMissing && !entry.isFetching ? "error"
      : !windowAvailable || !entry.snapshot || loading || readSnapshotFetching ? "pending"
        : messages.length ? "ready" : "empty"
  return {
    ...query, observation: { snapshot_source: entry.resource?.source ?? "unknown" as const, target_coverage: windowAvailable ? "covered" as const : "uncovered" as const,
      wait_reason: !entry.canRead ? "entry" as const : !windowAvailable ? "window" as const : loading ? "projection" as const : "none" as const },
    messages, canonicalMessages: canonicalBase, canonicalById,
    latestSeq, hasMoreOlder, hasMoreNewer, historyStartKnown, hasMore: hasMoreOlder,
    isLoading: loading, isPending: loading, isError: !!initialLoadError && !query.data,
    error, initialLoadError, isFetching: entry.isFetching || query.isFetching,
    isFetchingOlder: query.isFetchingNextPage,
    isFetchingNewer: query.isFetchingPreviousPage || selection.pending,
    fetchOlder, fetchNewer, jumpToPresent, presentVersion: selection.version, presentRequest: selection.request,
    anchorReconciled: !!selectedWindow,
    navigationBlocked: !entry.canRead,
    readSnapshot: entry.snapshot, readSnapshotFetching,
    initialPositionKnown: !!selectedWindow && entry.snapshot !== null && !loading && !readSnapshotFetching,
    initialPositionMessageId: entry.initialPositionMessageId, positionEntry, positionDataState, messageWindow: query.data,
    retryInitialLoad, retryingInitialLoad: entry.isFetching || query.isFetching,
    entryCanRead: entry.canRead, entryDenied: entry.denied, entryAnchorMissing: entry.anchorMissing,
  }
}
