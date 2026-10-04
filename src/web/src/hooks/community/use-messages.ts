"use client"
import { useAtom, useCreateAtom } from "@tanstack/react-store";
import { getCommunityDbRegistry } from "@/lib/community-db/collections"

import { getCommunityRuntime } from "@/stores/community/runtime"


import {
  useInfiniteQuery,
  useQuery,
  QueryObserver,
  focusManager,
  onlineManager,
  useIsRestoring,
  useQueryClient,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import type {
  MessagesWindowPage as MessagesPage,
  MessagesPage as WireMessagesPage,
  MessagesPageParam,
  Msg,
} from "@/lib/community/models/message"
import { messageWindowPage } from "@/lib/community/models/message"
import {
  materializeMessageStream,
  type CanonicalMessage,
  type MessageScope,
} from "@/lib/community/message-stream"
import { useMessageOverlay } from "@/stores/community/message-stream"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  commitConversationNavigationProof,
  recordConversationNavigationReceipt,
  useConversationNavigationGate,
} from "@/lib/community/conversation-navigation-proof"
import type { MessageSurfaceReceipt } from "@/lib/community/conversation-navigation-proof"
import { useMessageProjection, useMessageWindowProjection, useOptionalCommunityDbRegistry } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
} from "@/lib/community-db/sync"
import { ConversationReadTimeoutError, conversationReadRetryPolicy, withConversationReadDeadline } from "@/lib/community/conversation-read"
import { messageReconcileOptions } from "./community-ws/reconnect-messages"

/**
 * Fetches paginated messages for a community channel.
 *
 * Bi-directional after A2: an anchor window centred on the viewer's
 * `lastReadMessageId` (or a jump-target id) may sit in the middle of history,
 * so pagination now flows both up (older, via `fetchOlder`) and down (newer,
 * via `fetchNewer`). Legacy "newest page" behaviour is preserved for the case
 * where no anchor is provided.
 *
 * TanStack convention: `fetchNextPage` appends to `pages`, `fetchPreviousPage`
 * prepends. We map "next" → older (further into the past = further along the
 * infinite scroll direction) and "previous" → newer, then expose them under
 * `fetchOlder` / `fetchNewer` so callers never see the TanStack naming.
 *
 * The query key nests under `communityKeys.channelMessages(channelId)` so a
 * single `invalidateQueries({ queryKey: communityKeys.channelMessages(id) })`
 * refreshes every page in one call.
 */
export type { MessagesPage, MessagesPageParam } from "@/lib/community/models/message"

export type { MessageSurfaceReceipt } from "@/lib/community/conversation-navigation-proof"

type CommittedTransportWindow = {
  key: string
  observed: boolean
}

function useCommittedTransportWindow(
  queryKey: readonly unknown[],
  hasData: boolean,
): boolean {
  const key = useMemo(() => JSON.stringify(queryKey), [queryKey])
  const [committed, setCommitted] = useAtom(useCreateAtom<CommittedTransportWindow>({
    key,
    observed: hasData,
  }))
  const observed = committed.key === key
    ? committed.observed || hasData
    : hasData

  // A suspended render may inspect another query key, but it must not advance
  // window ownership. Commit the sticky "observed" bit only after React has
  // accepted this render, and reset it semantically when the key commits.
  useLayoutEffect(() => {
    setCommitted((current) => {
      const nextObserved = current.key === key
        ? current.observed || hasData
        : hasData
      if (current.key === key && current.observed === nextObserved) return current
      return { key, observed: nextObserved }
    })
  }, [hasData, key, setCommitted])

  return observed
}

type MessagesTransportPage = WireMessagesPage & {
  surfaceReceipt?: MessageSurfaceReceipt
}

type MessagesTransportOptions = {
  onSurfaceReceipt?: (receipt: MessageSurfaceReceipt) => void
  queryClient?: QueryClient
}

function isMessageSurfaceReceipt(value: unknown): value is MessageSurfaceReceipt {
  if (!value || typeof value !== "object") return false
  const receipt = value as Partial<MessageSurfaceReceipt>
  return typeof receipt.channelId === "string" && (
    receipt.surfaceKind === "channel" ||
    receipt.surfaceKind === "thread" ||
    receipt.surfaceKind === "forum" ||
    receipt.surfaceKind === "dm"
  )
}

function buildMessagesUrl(base: string, pageParam: MessagesPageParam, tag?: string | null): string {
  const params = new URLSearchParams()
  if (tag) params.set("tag", tag)
  switch (pageParam.mode) {
    case "newest":
      break
    case "older":
      params.set("cursor", pageParam.cursor)
      break
    case "newer":
      params.set("since", pageParam.cursor)
      break
    case "since":
      params.set("since", pageParam.since)
      break
    case "anchor":
      params.set("anchor", pageParam.anchor)
      break
  }
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

async function fetchMessagesTransport(
  queryClient: QueryClient,
  url: string,
  signal: AbortSignal | undefined,
  options: MessagesTransportOptions | undefined,
): Promise<WireMessagesPage> {
  const transport = await withConversationReadDeadline(signal, (readSignal) => apiFetchProfiles<MessagesTransportPage>(
    url,
    (page) => messageProfilePatches(page.messages),
    { signal: readSignal }, getCommunityDbRegistry(queryClient),
  ))
  const { surfaceReceipt, ...page } = transport
  if (isMessageSurfaceReceipt(surfaceReceipt)) {
    options?.onSurfaceReceipt?.(surfaceReceipt)
  }
  return page
}

export const channelMessagesQueryFn =
  (channelId: string, tag?: string | null, options?: MessagesTransportOptions) =>
  async ({
    pageParam,
    signal,
    client,
  }: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
    client?: QueryClient
  }): Promise<MessagesPage> => {
    const originalClient = options?.queryClient ?? client
    if (!originalClient) throw new DOMException("Missing message query owner", "AbortError")
    const publicationToken = captureCommunityLiveSnapshotToken(originalClient)
    const url = buildMessagesUrl(
      `/api/community/channels/${channelId}/messages`,
      pageParam,
      tag,
    )
    const page = await fetchMessagesTransport(originalClient, url, signal, options)
    {
      publishCommunityMessages(originalClient, {
        channelId,
        messages: page.messages,
        proof: { token: publicationToken, signal },
      })
    }
    return messageWindowPage(page)
  }

export const dmMessagesQueryFn =
  (dmId: string, options?: MessagesTransportOptions) =>
  async ({
    pageParam,
    signal,
    client,
  }: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
    client?: QueryClient
  }): Promise<MessagesPage> => {
    const originalClient = options?.queryClient ?? client
    if (!originalClient) throw new DOMException("Missing message query owner", "AbortError")
    const publicationToken = captureCommunityLiveSnapshotToken(originalClient)
    const url = buildMessagesUrl(
      `/api/community/channels/${dmId}/messages`,
      pageParam,
    )
    const page = await fetchMessagesTransport(originalClient, url, signal, options)
    {
      publishCommunityMessages(originalClient, {
        channelId: dmId,
        messages: page.messages,
        proof: { token: publicationToken, signal },
      })
    }
    return messageWindowPage(page)
  }

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

// Anchor-drift repair uses age only to decide whether a fetched anchor page
// should merge into a trustworthy same-session window or replace an older
// hydrated window. General mount freshness is owned by the query's
// `staleTime: 0` contract below, not by this threshold.
const ANCHOR_CACHE_FRESHNESS_MS = 30_000

type PageCache = InfiniteData<MessagesPage, MessagesPageParam>

function cacheHasAnchorPage(
  cache: PageCache | undefined,
  anchorId: string | null,
): boolean {
  if (!anchorId || !cache) return false
  return cache.pageParams.some((pageParam) => (
    pageParam.mode === "anchor" && pageParam.anchor === anchorId
  ))
}

function cachedWindowNeedsAnchor(
  pages: MessagesPage[] | undefined,
  anchorId: string | null,
): boolean {
  if (!anchorId || !pages || pages.length === 0) return false
  let hasMessages = false
  for (const page of pages) {
    for (const message of page.messages) {
      hasMessages = true
      if (message.id === anchorId) return false
    }
  }
  return hasMessages
}

function cachedWindowNeedsAnchorReconcile(
  cache: PageCache | undefined,
  anchorId: string | null,
  reconcileLateAnchor: boolean,
): boolean {
  if (!anchorId || !cache || cache.pages.length === 0) return false
  if (cachedWindowNeedsAnchor(cache.pages, anchorId)) return true
  if (!reconcileLateAnchor) return false
  const hasMessages = cache.pages.some((page) => page.messages.length > 0)
  return hasMessages && !cacheHasAnchorPage(cache, anchorId)
}

type MessagesReturn = Omit<UseInfiniteQueryResult<PageCache, Error>, "isLoading"> & {
  messages: Msg[]
  latestSeq: number
  hasMoreOlder: boolean
  hasMoreNewer: boolean
  isFetchingOlder: boolean
  isFetchingNewer: boolean
  fetchOlder: () => void
  fetchNewer: () => void
  jumpToPresent: () => void
  presentVersion: number
  anchorReconciled: boolean
  // Legacy alias — mirrors `hasMoreOlder`. Kept so consumers not yet migrated
  // off the older-only API still compile until every call site is updated.
  hasMore: boolean
  // Widened from the query's own status-discriminated literal (`true`/
  // `false` narrowed by `status`) to a plain boolean — see the override
  // below, which also folds in `!anchorResolved` so a disabled query (still
  // waiting on the anchor snapshot) reports loading too.
  isLoading: boolean
  navigationBlocked: boolean
}

type MessagesOpts = {
  /** Viewer identity used only by the ephemeral inbox-navigation paint gate. */
  viewerUserId?: string
  /** Server-side message-tag filter. Null/undefined means the complete set. */
  tag?: string | null
  /**
   * Anchor for the initial fetch. Undefined = read-state not resolved yet;
   * the hook stays disabled until this becomes a value or `null`. `null`
   * = no anchor (never read / DM without snapshot); goes straight to
   * newest-mode. A string = fetch `?anchor=<id>` on the first page.
   */
  lastReadMessageId?: string | null
  /**
   * Explicit jump target (e.g. a cross-channel "jump to message"). Takes
   * precedence over `lastReadMessageId` so the channel opens centered on the
   * requested message rather than the viewer's unread marker. When set, it
   * also satisfies the enable-gate on its own — a jump firing before the
   * read snapshot resolves must NOT leave the query disabled.
   */
  anchorMessageId?: string | null
  /**
   * Default true preserves anchor-first consumers. Channel first paint sets
   * false so newest messages and read-state load independently; a late read
   * pointer is reconciled by the existing anchor-repair effect.
   */
  waitForAnchor?: boolean
  /**
   * Defaults to the inverse of `waitForAnchor`. A warm semantic return can
   * disable the extra late-anchor window fetch when its cached messages
   * already contain the resolved read pointer; a genuinely missing anchor
   * still repairs once.
   */
  reconcileLateAnchor?: boolean
  /**
   * A warm same-session return can skip observer-subscribe revalidation
   * because WS and reconnect reconciliation already keep that cache current;
   * cold or cache-miss mounts still fetch normally. When omitted, defer to
   * the QueryClient's existing refetch-on-mount policy.
   */
  revalidateOnMount?: boolean
}

type ChannelMessagesOpts = MessagesOpts & {
  serverId: string
}

type PresentOverride = {
  attemptId: number
  phase: "requested" | "present"
  viewKey: string
}

type ActivationRevalidationState = {
  abortedAttemptId: number | null
  activeAttemptId: number | null
  attemptId: number
  pending: Promise<unknown> | null
  completed: boolean
  activationKey: string
}

type InitialWindowReceipt = {
  pageParam: MessagesPageParam
  viewKey: string
}

type InitialMessagesPageParam = Extract<
  MessagesPageParam,
  { mode: "newest" | "anchor" }
>

function sameMessagesPageParam(
  left: MessagesPageParam | undefined,
  right: InitialMessagesPageParam,
): boolean {
  if (!left || left.mode !== right.mode) return false
  switch (right.mode) {
    case "newest":
      return true
    case "anchor":
      return left.mode === "anchor" && left.anchor === right.anchor
  }
}

// Shared pagination + reducer used by both channel and DM hooks. Kept inline
// as a hook because both variants need the same TanStack setup — factoring
// out a plain function would leak query internals; a hook stays clean.
function useMessagesInner(
  scopeId: string | null,
  queryKey: readonly unknown[],
  queryFn: (context: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
  }) => Promise<MessagesPage>,
  opts: MessagesOpts | undefined,
): MessagesReturn {
  const queryClient = useQueryClient()
  const isRestoring = useIsRestoring()
  useQuery({ ...messageReconcileOptions(queryClient, scopeId ?? "__none__", queryKey), enabled: false })

  // `undefined` = anchor snapshot is still resolving; gate the query on it
  // being a resolved value (string OR null). Owners without a snapshot
  // (currently DM) pass `null` explicitly. An explicit `anchorMessageId`
  // (jump target) satisfies the gate on its own — a jump must not wait on the
  // read snapshot.
  const anchorResolved = opts?.waitForAnchor === false
    || opts?.anchorMessageId != null
    || opts?.lastReadMessageId !== undefined
  // Jump target wins over the read pointer for the initial anchor window.
  const anchorId = opts?.anchorMessageId ?? opts?.lastReadMessageId ?? null
  const enabled = !!scopeId && anchorResolved
  const reconcileLateAnchor = opts?.reconcileLateAnchor
    ?? (opts?.waitForAnchor === false)
  const viewKey = useMemo(
    () => JSON.stringify([queryKey, opts?.anchorMessageId ?? null]),
    [queryKey, opts?.anchorMessageId],
  )
  const attemptIdRef = useRef(0)
  const snapshotRef = useRef<{
    attemptId: number
    data: PageCache | undefined
    viewKey: string
  } | null>(null)
  const [activationRetryEpoch, setActivationRetryEpoch] = useAtom(useCreateAtom(0))
  const [presentOverride, setPresentOverride] = useAtom(useCreateAtom<PresentOverride | null>(null))
  const forceNewest = presentOverride?.viewKey === viewKey
  const jumpPending = forceNewest && presentOverride?.phase === "requested"

  const initialPageParam = useMemo<InitialMessagesPageParam>(() => {
    if (forceNewest) return { mode: "newest" }
    if (anchorId) return { mode: "anchor", anchor: anchorId }
    return { mode: "newest" }
  }, [forceNewest, anchorId])
  const activationKey = useMemo(
    () => JSON.stringify([viewKey, initialPageParam]),
    [initialPageParam, viewKey],
  )
  const activationRevalidationRef = useRef<ActivationRevalidationState>({
    abortedAttemptId: null,
    activeAttemptId: null,
    attemptId: 0,
    pending: null,
    completed: false,
    activationKey,
  })
  const initialWindowReceiptRef = useRef<InitialWindowReceipt | null>(null)

  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    PageCache,
    typeof queryKey,
    MessagesPageParam
  >({
    queryKey,
    // `enabled` is the execution gate. Keep the real transport installed even
    // while the read-state anchor is resolving: a retained observer can be
    // explicitly refetched during the disabled→enabled commit before
    // TanStack's passive option update runs. Installing a rejecting sentinel
    // here made that one-shot revalidation fail locally without issuing the
    // required `/messages` request.
    queryFn: async (context) => {
      const stateAtStart = activationRevalidationRef.current
      const attemptId = stateAtStart.activationKey === activationKey
        ? stateAtStart.activeAttemptId
        : null
      const transportSignal = context.signal
      const markAborted = () => {
        if (
          attemptId !== null
          && activationRevalidationRef.current === stateAtStart
          && stateAtStart.activationKey === activationKey
          && stateAtStart.activeAttemptId === attemptId
        ) {
          stateAtStart.abortedAttemptId = attemptId
        }
      }
      transportSignal?.addEventListener("abort", markAborted, { once: true })
      try {
        return await queryFn({ pageParam: context.pageParam, signal: transportSignal })
      } finally {
        transportSignal?.removeEventListener("abort", markAborted)
      }
    },
    initialPageParam,
    retry: conversationReadRetryPolicy(queryClient.defaultQueryOptions({ queryKey }).retry),
    networkMode: "always",
    // "next" = older side. `fetchNextPage` appends to `data.pages`, so the
    // LAST entry in `pages` is the oldest window we've loaded — that's the
    // page whose cursor gets consulted for the next older fetch.
    getNextPageParam: (last) => {
      const has = last.hasMoreOlder ?? last.hasMore ?? false
      if (!has) return undefined
      const cursor = last.olderCursor ?? last.cursor
      if (!cursor) return undefined
      return { mode: "older", cursor }
    },
    // "previous" = newer side. `fetchPreviousPage` prepends to `data.pages`,
    // so the FIRST entry is the newest window loaded. In legacy (newest)
    // mode `hasMoreNewer` is absent → falsy → no previous page.
    getPreviousPageParam: (first) => {
      if (!first.hasMoreNewer) return undefined
      const cursor = first.newerCursor
      if (!cursor) return undefined
      return { mode: "newer", cursor }
    },
    enabled,
    // Explicit mount policy is owned below: `false` skips it, `true` performs
    // the anchor-normalized observer refetch. Disable TanStack's parallel
    // mount refetch for both so it cannot replay a pre-resolution pageParam.
    ...(opts?.revalidateOnMount !== undefined ? { refetchOnMount: false } : {}),
    refetchOnReconnect: false,
    // Canonical message rows are persisted, while transport page ownership
    // and accepted/session rows stay in memory. Ordinary observers stay stale; opt-in cached mounts
    // are held fresh only until the anchor-normalized revalidation below owns
    // their request. Once this mounted observer has seen a real request, hold
    // it fresh so a later disabled→enabled transition cannot duplicate that
    // request. TanStack keeps cached pages painted during the fetch. A nonempty
    // window missing the resolved anchor is also held fresh: Fix 3 below owns
    // that repair and must fetch the NEW anchor page before any persisted
    // pageParam can replace or discard the existing history.
    staleTime: (cachedQuery) => (
      // Opt-in cached mounts are revalidated explicitly below so the request
      // can first normalize its semantic page identity. Mark them fresh here
      // to prevent TanStack's enabled-transition fetch from racing that owner
      // with an older cursor/newest pageParam.
      (opts?.revalidateOnMount === true && cachedQuery.state.data !== undefined)
      || cachedWindowNeedsAnchorReconcile(
        cachedQuery.state.data as PageCache | undefined,
        forceNewest ? null : anchorId,
        reconcileLateAnchor,
      )
    ) ? Infinity : 0,
  })
  const refetchMountedObserver = query.refetch
  const anchorRepairNeeded = cachedWindowNeedsAnchorReconcile(
    query.data,
    anchorId,
    reconcileLateAnchor,
  )
  useLayoutEffect(() => {
    const mountedQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
    if (!mountedQuery) return
    return queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated"
        && event.query.queryHash === mountedQuery.queryHash
        && event.action.type === "success"
        && !event.action.manual
        && event.query.state.fetchMeta === null
      ) {
        const receiptPageParam = (event.query.state.data as PageCache | undefined)
          ?.pageParams[0]
        if (!receiptPageParam) return
        initialWindowReceiptRef.current = {
          pageParam: receiptPageParam,
          viewKey,
        }
        const state = activationRevalidationRef.current
        if (
          state.activationKey === activationKey
          && sameMessagesPageParam(receiptPageParam, initialPageParam)
        ) {
          state.completed = true
          state.activeAttemptId = null
          state.abortedAttemptId = null
          state.pending = null
        }
      }
    })
  }, [activationKey, initialPageParam, queryClient, queryKey, viewKey])

  useLayoutEffect(() => {
    let state = activationRevalidationRef.current
    if (state.activationKey !== activationKey) {
      state = {
        abortedAttemptId: null,
        activeAttemptId: null,
        attemptId: 0,
        pending: null,
        completed: false,
        activationKey,
      }
      activationRevalidationRef.current = state
    }
    if (isRestoring || forceNewest || state.completed || state.pending) return
    if (!enabled || query.data === undefined || opts?.revalidateOnMount !== true) return

    const receipt = initialWindowReceiptRef.current
    if (
      receipt?.viewKey === viewKey
      && sameMessagesPageParam(receipt.pageParam, initialPageParam)
    ) {
      state.completed = true
      return
    }

    // Guarantee one actual post-mount fetch for cached conversation observers.
    // A retained observer can mount after restore and read-state have already
    // settled, so neither lifecycle is a reliable prerequisite. Retained cache
    // writes are also not proof that the network ran. The query-cache
    // subscription distinguishes manual cache success from a completed
    // request. Refetch through this observer rather than asking the cache for
    // "active" queries: while PersistQueryClientProvider hands hydration back
    // to React, the mounted observer can briefly fail that cache-level filter.
    // An infinite-query refetch replays its first retained pageParam. Normalize
    // that identity to this mount's resolved anchor/newest target first: after
    // older pagination or hydration the stored first param can be a cursor,
    // which must never outrun the read-state anchor on a retained mount.
    // Running in layout also starts the semantic revalidation before the
    // message-list's passive IntersectionObserver can request another page.
    queryClient.setQueryData<PageCache>(queryKey, (current) => current
      ? {
          ...current,
          pageParams: [initialPageParam, ...current.pageParams.slice(1)],
        }
      : current)
    state.attemptId += 1
    const attemptId = state.attemptId
    state.activeAttemptId = attemptId
    state.abortedAttemptId = null
    const request = refetchMountedObserver({ cancelRefetch: false })
    state.pending = request
    const settleAttempt = () => {
      if (state.pending === request) state.pending = null
      if (state.completed) return
      if (
        state.abortedAttemptId === attemptId
        && state.activeAttemptId === attemptId
        && activationRevalidationRef.current === state
        && state.activationKey === activationKey
      ) {
        state.activeAttemptId = null
        setActivationRetryEpoch((epoch) => epoch + 1)
      }
    }
    void request.then(settleAttempt, settleAttempt)
  }, [activationRetryEpoch, activationKey, anchorRepairNeeded, enabled, forceNewest, initialPageParam, isRestoring, opts?.revalidateOnMount, query.data, queryClient, queryKey, refetchMountedObserver, viewKey, setActivationRetryEpoch])

  useEffect(() => {
    setPresentOverride((current) => current?.viewKey === viewKey ? current : null)
  }, [setPresentOverride, viewKey])

  useEffect(() => {
    if (!jumpPending || !presentOverride) return
    snapshotRef.current = {
      attemptId: presentOverride.attemptId,
      data: queryClient.getQueryData<PageCache>(queryKey),
      viewKey,
    }
    void queryClient.resetQueries({ queryKey, exact: true })
  }, [jumpPending, presentOverride, queryClient, queryKey, viewKey])

  useEffect(() => {
    if (!jumpPending || !presentOverride) return
    const first = query.data?.pages[0]
    if (!first) return
    const isNewestShape = first.hasMore !== undefined && first.hasMoreOlder === undefined
    if (!isNewestShape) return
    snapshotRef.current = null
    setPresentOverride((current) =>
      current?.attemptId === presentOverride.attemptId
        ? { ...current, phase: "present" }
        : current)
  }, [jumpPending, presentOverride, query.data, setPresentOverride])

  useEffect(() => {
    if (!jumpPending || !presentOverride || !query.isError) return
    const snapshot = snapshotRef.current
    if (
      snapshot?.attemptId === presentOverride.attemptId
      && snapshot.viewKey === viewKey
      && snapshot.data
    ) {
      queryClient.setQueryData<PageCache>(queryKey, snapshot.data)
    }
    snapshotRef.current = null
    setPresentOverride((current) =>
      current?.attemptId === presentOverride.attemptId ? null : current)
  }, [jumpPending, presentOverride, query.isError, queryClient, queryKey, setPresentOverride, viewKey])

  const messageQuery = queryClient.getQueryCache().find({ queryKey, exact: true })
  const paginationOwnerRef = useRef<{ activationKey: string; query: typeof messageQuery } | null>(null)
  useLayoutEffect(() => {
    if (!enabled || !messageQuery) { paginationOwnerRef.current = null; return }
    const owner = { activationKey, query: messageQuery }
    paginationOwnerRef.current = owner
    return () => { if (paginationOwnerRef.current === owner) paginationOwnerRef.current = null }
  }, [activationKey, enabled, messageQuery])
  useLayoutEffect(() => {
    if (!enabled || !messageQuery) return
    // A native observer spans the route's commit gap. The next mount joins
    // the same Query before this lease is released on the next task.
    const lease = new QueryObserver(queryClient, { ...messageQuery.options, queryKey, enabled: false })
    const release = lease.subscribe(() => undefined)
    return () => { setTimeout(release, 0) }
  }, [enabled, messageQuery, queryClient, queryKey])
  const settledAnchorRepairRef = useRef<{ key: string; query: unknown } | null>(null)
  const anchorRepairFailedRef = useRef(false)
  const [anchorRetryEpoch, setAnchorRetryEpoch] = useAtom(useCreateAtom(0))
  useEffect(() => {
    const retry = (ready: boolean) => {
      if (ready && anchorRepairFailedRef.current) setAnchorRetryEpoch((epoch) => epoch + 1)
    }
    const unsubscribeFocus = focusManager.subscribe(retry)
    const unsubscribeOnline = onlineManager.subscribe(retry)
    return () => {
      unsubscribeFocus()
      unsubscribeOnline()
    }
  }, [setAnchorRetryEpoch])
  useEffect(() => {
    if (!enabled) return
    if (forceNewest) return
    if (!anchorId) return
    // The opt-in mount owner has already normalized the first page to this
    // anchor and started its observer refetch. Do not launch the independent
    // repair path in the same commit before the observer update is rendered.
    if (activationRevalidationRef.current.pending) return
    if (query.isFetching) return
    if (query.isPending) return
    if (!anchorRepairNeeded || !messageQuery) return
    const updatedAt = messageQuery.state.dataUpdatedAt
    const isFresh = !!updatedAt && Date.now() - updatedAt < ANCHOR_CACHE_FRESHNESS_MS
    const anchorPageParam: MessagesPageParam = { mode: "anchor", anchor: anchorId }
    const accessToken = captureChannelMetadataToken(queryClient, scopeId!)
    const currentQuery = messageQuery
    let active = true
    const isCurrent = () => active && isChannelMetadataTokenCurrent(accessToken)
      && queryClient.getQueryCache().find({ queryKey, exact: true }) === currentQuery
    const accessIdentity = [accessToken.viewerId, accessToken.accountEpoch, accessToken.accessEpoch, accessToken.ownerGeneration, accessToken.generation]
    const anchorRequestKey = JSON.stringify([queryKey, anchorPageParam, accessIdentity])
    if (settledAnchorRepairRef.current?.key === anchorRequestKey
      && settledAnchorRepairRef.current.query === currentQuery) return
    anchorRepairFailedRef.current = false
    const repairOptions = { queryKey: [...queryKey, "anchor-repair", anchorId, accessIdentity], queryFn: ({ signal }: { signal: AbortSignal }) => {
      if (!isChannelMetadataTokenCurrent(accessToken) || queryClient.getQueryCache().find({ queryKey, exact: true }) !== currentQuery) throw new DOMException("Retired message window", "AbortError")
      return queryFn({ pageParam: anchorPageParam, signal })
    }, staleTime: 0, networkMode: "always" as const, retry: (attempt: number, error: unknown) => !(error instanceof ConversationReadTimeoutError) && !(error instanceof DOMException && error.name === "AbortError") && attempt < 2, retryDelay: (attempt: number) => 1000 * 2 ** attempt }
    const lease = new QueryObserver(queryClient, { ...repairOptions, enabled: false })
    const unsubscribe = lease.subscribe(() => undefined)
    const releaseOnRemoval = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed" && event.query === currentQuery) {
        active = false
        void queryClient.cancelQueries({ queryKey: repairOptions.queryKey, exact: true })
        unsubscribe()
      }
    })
    const repair = () => {
      if (!isCurrent()) return
      void queryClient.fetchQuery(repairOptions)
        .then((page) => {
          // Re-check right before the swap — a concurrent send/WS update or a
          // second re-anchor attempt in the interim shouldn't be clobbered by
          // a now-outdated fetch result landing late.
          if (!isCurrent()) return
          settledAnchorRepairRef.current = { key: anchorRequestKey, query: currentQuery }
          anchorRepairFailedRef.current = false
          queryClient.setQueryData<PageCache>(queryKey, (current) => {
            // Stale replace-path: use the fresh page even if `current` is
            // somehow absent — never fall back to leaving an un-anchored
            // window in place.
            if (!isFresh) {
              return { pages: [page], pageParams: [anchorPageParam] }
            }
            if (!current) return current
            // Fresh merge-path: fold the freshly-fetched anchor page into the
            // ALREADY-LOADED history rather than replacing `pages` outright —
            // discarding it would drop every page the user loaded via
            // `fetchOlder` (scroll-up pagination), which surfaced as history
            // vanishing on channel switch. `mergeMessagesPages` sorts +
            // dedupes by id, so overlapping rows between the old window and
            // the new anchor page collapse cleanly. The merged set collapses
            // into a single page — `hasMoreOlder`/`hasMoreNewer` come from the
            // new anchor page since it alone knows the true state of both
            // edges relative to the (possibly wider) merged window.
            const currentMessages = mergeMessagesPages(current.pages)
            const anchorAlreadyPainted = opts?.waitForAnchor === false
              && currentMessages.some((message) => message.id === anchorId)
            if (anchorAlreadyPainted) return { ...current, pages: [page, ...current.pages], pageParams: [anchorPageParam, ...current.pageParams] }
            return { ...current, pages: [page, ...current.pages], pageParams: [anchorPageParam, ...current.pageParams] }
          })
        })
        .catch(() => {
          if (!isCurrent()) return
          anchorRepairFailedRef.current = true
        })
    }
    repair()
    return () => {
      active = false
      releaseOnRemoval()
      setTimeout(unsubscribe, 0)
    }
  }, [
    anchorRetryEpoch,
    enabled,
    forceNewest,
    anchorId,
    scopeId,
    anchorRepairNeeded,
    messageQuery,
    query.isFetching,
    query.isPending,
    queryClient,
    queryKey,
    queryFn,
    opts?.waitForAnchor,
    reconcileLateAnchor,
  ])

  const windowIds = useMemo(() => query.data?.pages.flatMap((page) => page.messages.map((message) => message.id)) ?? [], [query.data])
  const canonicalRows = useMessageProjection(scopeId, windowIds)
  const messages = useMemo<Msg[]>(() => {
    if (!query.data) return []
    const byId = new Map((canonicalRows ?? []).map((message) => [message.id, message]))
    return mergeMessagesPages(query.data.pages).flatMap((window) => { const message = byId.get(window.id); return message ? [message] : [] })
  }, [query.data, canonicalRows])

  const latestSeq = useMemo<number>(() => {
    if (!query.data) return 0
    let max = 0
    for (const p of query.data.pages) {
      const s = p.latestSeq ?? 0
      if (s > max) max = s
    }
    return max
  }, [query.data])

  const pages = query.data?.pages ?? []
  const oldestPage = pages[pages.length - 1]
  const newestPage = pages[0]
  const hasMoreOlder = (oldestPage?.hasMoreOlder ?? oldestPage?.hasMore) ?? false
  const hasMoreNewer = newestPage?.hasMoreNewer ?? false

  const fetchPage = useCallback((direction: "older" | "newer") => {
    const owner = paginationOwnerRef.current
    if (!enabled || !scopeId || !owner?.query || owner.activationKey !== activationKey) return
    if (direction === "older" ? !query.hasNextPage || query.isFetchingNextPage
      : !query.hasPreviousPage || query.isFetchingPreviousPage) return
    const currentQuery = owner.query
    const accessToken = captureChannelMetadataToken(queryClient, scopeId)
    const isCurrent = () => paginationOwnerRef.current === owner
      && activationRevalidationRef.current.activationKey === activationKey
      && queryClient.getQueryCache().find({ queryKey, exact: true }) === currentQuery
      && isChannelMetadataTokenCurrent(accessToken)
    const fetch = async () => {
      const activationRequest = activationRevalidationRef.current.pending
      if (activationRequest) await activationRequest
      while (isCurrent() && currentQuery.state.fetchStatus !== "idle") {
        await query.refetch({ cancelRefetch: false })
      }
      if (!isCurrent()) return
      if (direction === "older") await query.fetchNextPage({ cancelRefetch: false })
      else await query.fetchPreviousPage({ cancelRefetch: false })
    }
    void fetch()
  }, [activationKey, enabled, query, queryClient, queryKey, scopeId])
  const fetchOlder = useCallback(() => fetchPage("older"), [fetchPage])
  const fetchNewer = useCallback(() => fetchPage("newer"), [fetchPage])

  const jumpToPresent = useCallback(() => {
    if (!enabled || forceNewest) return
    attemptIdRef.current += 1
    setPresentOverride({
      attemptId: attemptIdRef.current,
      phase: "requested",
      viewKey,
    })
  }, [enabled, forceNewest, setPresentOverride, viewKey])

  return {
    ...query,
    // Instant channel switch: a warm channel already has its newest-tail
    // restored in canonical message rows
    // before the read anchor resolves. Those rows must paint immediately rather
    // than wait on the read-snapshot round-trip — switching must not
    // happen on a network timescale. So only report loading when there is
    // genuinely nothing to show yet.
    //
    // `!anchorResolved` alone used to force loading=true on every mount: while
    // the anchor snapshot resolves the query is `enabled: false`, and TanStack
    // forces `isFetching` false in that state, so native
    // `isLoading = isPending && isFetching` computes to `false` even with no
    // data — leaving callers a frame of "ready but empty". We still guard that
    // empty case, but a non-empty canonical tail is warm and renders
    // now. The scroll-to-bottom / NEW-divider / unread count stay gated in the
    // page + `useScrollAnchor` (which now scrolls a warm tail to the bottom on
    // first paint and converges the divider once the snapshot lands), so early
    // painting can't strand the viewport at the top. A cold channel (empty
    // cache) still shows the skeleton.
    isLoading: query.isLoading || (!anchorResolved && messages.length === 0),
    navigationBlocked: false,
    messages,
    latestSeq,
    hasMoreOlder,
    hasMoreNewer,
    isFetchingOlder: query.isFetchingNextPage,
    isFetchingNewer: query.isFetchingPreviousPage || jumpPending,
    fetchOlder,
    fetchNewer,
    jumpToPresent,
    presentVersion: forceNewest && presentOverride?.phase === "present"
      ? presentOverride.attemptId
      : 0,
    anchorReconciled: !anchorId
      || cacheHasAnchorPage(query.data, anchorId)
      || (!reconcileLateAnchor && !cachedWindowNeedsAnchor(query.data?.pages, anchorId)),
    hasMore: hasMoreOlder,
  }
}

/**
 * Hook wrapper around `useInfiniteQuery` for a channel's message stream.
 *
 * Pass `null` for "no active channel" — the query stays disabled. DM views
 * should call `useDmMessages` instead of this hook.
 */
export function useMessages(
  channelId: string | null,
  opts: ChannelMessagesOpts,
): MessagesReturn {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const queryKey = useMemo(() => {
    const baseKey = communityKeys.channelMessages(channelId ?? "__none__")
    return opts.tag ? [...baseKey, "tag", opts.tag] as const : baseKey
  }, [channelId, opts.tag])
  const queryFn = useMemo(
    () => channelMessagesQueryFn(channelId ?? "__none__", opts.tag, {
      queryClient,
      onSurfaceReceipt: (receipt) => {
        recordConversationNavigationReceipt(
          queryClient,
          receipt,
          accessEpoch,
        )
      },
    }),
    [accessEpoch, channelId, opts.tag, queryClient],
  )
  const base = useMessagesInner(
    channelId,
    queryKey,
    queryFn,
    opts,
  )
  const transportWindowObserved = useCommittedTransportWindow(
    queryKey,
    base.data !== undefined,
  )
  const windowIds = useMemo(() => base.messages.map((message) => message.id), [base.messages])
  const dbMessages = useMessageWindowProjection(channelId, transportWindowObserved ? windowIds : undefined)
  const canonicalMessagesById = useMemo(() => new Map((dbMessages ?? []).map((message) => [message.id, message])), [dbMessages])
  const scope = useMemo<MessageScope>(() => ({
    kind: "channel",
    id: channelId ?? "__none__",
    serverId: opts.serverId,
  }), [channelId, opts.serverId])
  const overlay = useMessageOverlay(scope)
  const canonicalBase = useMemo(
    () => {
      const messages = !registry
        ? base.messages
        : !transportWindowObserved
          ? dbMessages ?? []
          : base.messages.flatMap((message) => {
              const canonical = canonicalMessagesById?.get(message.id)
              return canonical ? [canonical] : []
            })
      return messages.filter(
        (message): message is CanonicalMessage => typeof message.seq === "number",
      )
    },
    [base.messages, canonicalMessagesById, dbMessages, registry, transportWindowObserved],
  )
  useEffect(() => {
    if (!channelId) return
    getCommunityRuntime(queryClient).messageStream.actions.dispatch(scope, {
      type: "baseChanged",
      messages: canonicalBase,
    })
  }, [canonicalBase, channelId, queryClient, scope])
  const messages = useMemo(
    () => materializeMessageStream(canonicalBase, overlay).filter((message) =>
      messageMatchesTag(message, opts.tag)),
    [canonicalBase, opts.tag, overlay],
  )
  useEffect(() => {
    if (!channelId || base.data === undefined) return
    commitConversationNavigationProof(queryClient, channelId, accessEpoch)
  }, [accessEpoch, base.data, base.dataUpdatedAt, channelId, queryClient])
  const navigationGate = useConversationNavigationGate(
    queryClient,
    opts.viewerUserId ?? "__none__",
    channelId ?? "__none__",
    accessEpoch,
  )
  const gated = navigationGate.required && !navigationGate.allowed
  return {
    ...base,
    messages: gated ? [] : messages,
    isLoading: (base.isLoading && canonicalBase.length === 0) || gated,
    navigationBlocked: gated,
  }
}

/**
 * DM-scoped sibling of `useMessages`. Same pagination shape, different route.
 */
export function useDmMessages(
  dmId: string | null,
  opts?: MessagesOpts,
): MessagesReturn {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const accessEpoch = useCommunityWsStore((state) => state.accessEpoch)
  const queryKey = useMemo(
    () => communityKeys.dmMessages(dmId ?? "__none__"),
    [dmId],
  )
  const queryFn = useMemo(
    () => dmMessagesQueryFn(dmId ?? "__none__", {
      queryClient,
      onSurfaceReceipt: (receipt) => {
        recordConversationNavigationReceipt(
          queryClient,
          receipt,
          accessEpoch,
        )
      },
    }),
    [accessEpoch, dmId, queryClient],
  )
  const base = useMessagesInner(
    dmId,
    queryKey,
    queryFn,
    opts,
  )
  const transportWindowObserved = useCommittedTransportWindow(
    queryKey,
    base.data !== undefined,
  )
  const windowIds = useMemo(() => base.messages.map((message) => message.id), [base.messages])
  const dbMessages = useMessageWindowProjection(dmId, transportWindowObserved ? windowIds : undefined)
  const canonicalMessagesById = useMemo(() => new Map((dbMessages ?? []).map((message) => [message.id, message])), [dbMessages])
  const scope = useMemo<MessageScope>(() => ({
    kind: "dm",
    id: dmId ?? "__none__",
  }), [dmId])
  const overlay = useMessageOverlay(scope)
  const canonicalBase = useMemo(
    () => {
      const messages = !registry
        ? base.messages
        : !transportWindowObserved
          ? dbMessages ?? []
          : base.messages.flatMap((message) => {
              const canonical = canonicalMessagesById?.get(message.id)
              return canonical ? [canonical] : []
            })
      return messages.filter(
        (message): message is CanonicalMessage => typeof message.seq === "number",
      )
    },
    [base.messages, canonicalMessagesById, dbMessages, registry, transportWindowObserved],
  )
  useEffect(() => {
    if (!dmId) return
    getCommunityRuntime(queryClient).messageStream.actions.dispatch(scope, {
      type: "baseChanged",
      messages: canonicalBase,
    })
  }, [canonicalBase, dmId, queryClient, scope])
  const messages = useMemo(
    () => materializeMessageStream(canonicalBase, overlay),
    [canonicalBase, overlay],
  )
  useEffect(() => {
    if (!dmId || base.data === undefined) return
    commitConversationNavigationProof(queryClient, dmId, accessEpoch)
  }, [accessEpoch, base.data, base.dataUpdatedAt, dmId, queryClient])
  const navigationGate = useConversationNavigationGate(
    queryClient,
    opts?.viewerUserId ?? "__none__",
    dmId ?? "__none__",
    accessEpoch,
  )
  const gated = navigationGate.required && !navigationGate.allowed
  return {
    ...base,
    messages: gated ? [] : messages,
    isLoading: (base.isLoading && canonicalBase.length === 0) || gated,
    navigationBlocked: gated,
  }
}
