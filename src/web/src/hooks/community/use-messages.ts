"use client"

import {
  useInfiniteQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type {
  MessagesPage,
  MessagesPageParam,
  Msg,
} from "@/lib/community/models/message"
import {
  materializeMessageStream,
  type CanonicalMessage,
  type MessageScope,
} from "@/lib/community/message-stream"
import { useMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"

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

export const channelMessagesQueryFn =
  (channelId: string, tag?: string | null) =>
  async ({
    pageParam,
    signal,
  }: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
  }): Promise<MessagesPage> => {
    const url = buildMessagesUrl(
      `/api/community/channels/${channelId}/messages`,
      pageParam,
      tag,
    )
    return apiFetchProfiles<MessagesPage>(
      url,
      (page) => messageProfilePatches(page.messages),
      signal ? { signal } : undefined,
    )
  }

export const dmMessagesQueryFn =
  (dmId: string) =>
  async ({
    pageParam,
    signal,
  }: {
    pageParam: MessagesPageParam
    signal?: AbortSignal
  }): Promise<MessagesPage> => {
    const url = buildMessagesUrl(
      `/api/community/channels/${dmId}/messages`,
      pageParam,
    )
    return apiFetchProfiles<MessagesPage>(
      url,
      (page) => messageProfilePatches(page.messages),
      signal ? { signal } : undefined,
    )
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
export function mergeMessagesPages(pages: MessagesPage[]): Msg[] {
  const all: Msg[] = []
  for (const p of pages) {
    for (const m of p.messages) all.push(m)
  }
  all.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
    if (ta !== tb) return ta - tb
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  const seen = new Set<string>()
  const out: Msg[] = []
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

const inflightAnchorRepairs = new WeakMap<
  QueryClient,
  Map<string, Promise<MessagesPage>>
>()

function fetchSharedAnchorRepair(
  queryClient: QueryClient,
  requestKey: string,
  fetchPage: () => Promise<MessagesPage>,
): Promise<MessagesPage> {
  let requests = inflightAnchorRepairs.get(queryClient)
  const pending = requests?.get(requestKey)
  if (pending) return pending

  if (!requests) {
    requests = new Map()
    inflightAnchorRepairs.set(queryClient, requests)
  }
  const request = fetchPage()
  requests.set(requestKey, request)
  const release = () => {
    if (requests.get(requestKey) !== request) return
    requests.delete(requestKey)
    if (requests.size === 0) inflightAnchorRepairs.delete(queryClient)
  }
  void request.then(release, release)
  return request
}

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
}

type MessagesOpts = {
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
  const [presentOverride, setPresentOverride] = useState<PresentOverride | null>(null)
  const forceNewest = presentOverride?.viewKey === viewKey
  const jumpPending = forceNewest && presentOverride?.phase === "requested"

  const initialPageParam = useMemo<MessagesPageParam>(() => {
    if (forceNewest) return { mode: "newest" }
    if (anchorId) return { mode: "anchor", anchor: anchorId }
    return { mode: "newest" }
  }, [forceNewest, anchorId])

  const query = useInfiniteQuery<
    MessagesPage,
    Error,
    PageCache,
    typeof queryKey,
    MessagesPageParam
  >({
    queryKey,
    queryFn: enabled
      ? queryFn
      : () => Promise.reject(new Error("disabled")),
    initialPageParam,
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
    ...(opts?.revalidateOnMount === false ? { refetchOnMount: false } : {}),
    refetchOnReconnect: false,
    // Message bases are persisted, while accepted/session rows live in an
    // in-memory overlay. Treat each ordinary active message query as stale so
    // disabled→enabled activation revalidates even inside the global 5-second
    // freshness window. TanStack keeps cached pages painted during the fetch.
    // A nonempty window missing the resolved anchor is the one exception: Fix
    // 3 below owns that repair and must fetch the NEW anchor page before any
    // persisted pageParam can replace or discard the existing history.
    staleTime: (cachedQuery) => cachedWindowNeedsAnchorReconcile(
      cachedQuery.state.data as PageCache | undefined,
      forceNewest ? null : anchorId,
      reconcileLateAnchor,
    ) ? Infinity : 0,
  })

  useEffect(() => {
    setPresentOverride((current) => current?.viewKey === viewKey ? current : null)
  }, [viewKey])

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
  }, [jumpPending, presentOverride, query.data])

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
  }, [jumpPending, presentOverride, query.isError, queryClient, queryKey, viewKey])

  // Fix 3 — anchor re-validation.
  //
  // When a persisted cache is rehydrated, TanStack uses the cached `pages`
  // even if `initialPageParam` says "anchor at m_42". If m_42 isn't in the
  // hydrated window (e.g. the persisted cache was a newest-tail and the
  // read pointer has since advanced past it), `newDividerBefore` computes
  // to `undefined` and the list snaps to bottom — no NEW divider, wrong
  // position.
  //
  // Detect that shape and re-anchor. Fire exactly once per (scopeId,
  // anchorId) pair via a ref — a subsequent watermark tick that advances
  // lastReadMessageId is a different pair and gets its own single
  // re-anchor opportunity.
  //
  // Two different causes need two different repairs:
  //   - Genuinely stale cache (cross-session IDB hydration, e.g. the Inbox-
  //     to-unread-channel case) — `resetQueries` is correct: the whole
  //     window is untrustworthy anyway.
  //   - Same-session anchor drift with a still-fresh cache (e.g. returning
  //     from a Thread after the watermark advanced past the window) — the
  //     already-loaded history is still valid. `resetQueries` would clear
  //     `pages` to empty and flash a blank list while it refetches. Instead,
  //     fetch a fresh anchor-centered page out of band and swap the query
  //     data directly once it lands — the view jumps straight from the old
  //     (valid) window to the new one, never passing through an empty state.
  const anchorResetKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    if (forceNewest) return
    if (!anchorId) return
    if (query.isFetching) return
    if (query.isPending) return
    if (!cachedWindowNeedsAnchorReconcile(
      query.data,
      anchorId,
      reconcileLateAnchor,
    )) return
    const resetKey = `${scopeId ?? ""}::${anchorId}`
    if (anchorResetKeyRef.current === resetKey) return
    anchorResetKeyRef.current = resetKey

    const updatedAt = query.dataUpdatedAt
    const isFresh = !!updatedAt && Date.now() - updatedAt < ANCHOR_CACHE_FRESHNESS_MS

    // Both branches fetch a fresh anchor-centered page out of band and swap
    // it in via `setQueryData` — NEITHER uses `resetQueries`. `resetQueries`
    // clears `pages` to empty synchronously, which flashes a second loading
    // skeleton mid-mount and, worse, wipes the virtualizer's measurement
    // cache so the one-shot mount scroll (fired once the refetch lands)
    // mis-targets and settles at the top hero instead of the NEW divider —
    // and the unread rows near the tail then never enter the viewport, so
    // the read watermark never advances. Keeping the old (renderable) window
    // on screen until the fresh page lands makes the transition a direct
    // swap with no empty frame (DESIGN.md "Fade, don't swap").
    //
    // The branches differ only in what they keep:
    //   - FRESH cache (same-session drift, e.g. returning from a Thread after
    //     the watermark advanced): the already-loaded history is still valid,
    //     so MERGE the new anchor page into it — dropping it would lose rows
    //     the user paged in via `fetchOlder`.
    //   - STALE cache (cross-session IDB hydration): the loaded window is
    //     untrustworthy, so REPLACE it with just the fresh anchor page.
    const anchorPageParam: MessagesPageParam = { mode: "anchor", anchor: anchorId }
    const anchorRequestKey = JSON.stringify([queryKey, anchorPageParam])
    fetchSharedAnchorRepair(
      queryClient,
      anchorRequestKey,
      () => queryFn({ pageParam: anchorPageParam }),
    )
      .then((page) => {
        // Re-check right before the swap — a concurrent send/WS update or a
        // second re-anchor attempt in the interim shouldn't be clobbered by
        // a now-outdated fetch result landing late.
        if (anchorResetKeyRef.current !== resetKey) return
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
          const merged = anchorAlreadyPainted
            ? currentMessages
            : mergeMessagesPages([...current.pages, page])
          const mergedPage: MessagesPage = {
            ...page,
            messages: merged,
          }
          return { pages: [mergedPage], pageParams: [anchorPageParam] }
        })
      })
      .catch(() => {
        // Out-of-band fetch failed — fall back to the reset path so the
        // scope isn't stuck showing a stale, un-anchored window forever.
        // This is the ONLY `resetQueries` path left: an outright fetch
        // failure has no fresh page to swap in, so the empty-then-refetch
        // flash is the acceptable last resort rather than the common case.
        void queryClient.resetQueries({ queryKey })
      })
  }, [
    enabled,
    forceNewest,
    anchorId,
    scopeId,
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.isPending,
    queryClient,
    queryKey,
    queryFn,
    opts?.waitForAnchor,
    reconcileLateAnchor,
  ])

  const messages = useMemo<Msg[]>(() => {
    if (!query.data) return []
    return mergeMessagesPages(query.data.pages)
  }, [query.data])

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

  // Callbacks depend on `query.*` fields that TanStack refreshes on every
  // internal state change — closing over the whole query object keeps the
  // exhaustive-deps rule happy without spelling every subfield.
  const fetchOlder = useCallback(() => {
    if (!query.hasNextPage) return
    if (query.isFetchingNextPage) return
    void query.fetchNextPage()
  }, [query])

  const fetchNewer = useCallback(() => {
    if (!query.hasPreviousPage) return
    if (query.isFetchingPreviousPage) return
    void query.fetchPreviousPage()
  }, [query])

  const jumpToPresent = useCallback(() => {
    if (!enabled || forceNewest) return
    attemptIdRef.current += 1
    setPresentOverride({
      attemptId: attemptIdRef.current,
      phase: "requested",
      viewKey,
    })
  }, [enabled, forceNewest, viewKey])

  return {
    ...query,
    // Instant channel switch: a warm channel already has its newest-tail
    // hydrated into `messages` (from the persisted `channelMessages` cache)
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
    // empty case, but a non-empty hydrated cache is the warm tail and renders
    // now. The scroll-to-bottom / NEW-divider / unread count stay gated in the
    // page + `useScrollAnchor` (which now scrolls a warm tail to the bottom on
    // first paint and converges the divider once the snapshot lands), so early
    // painting can't strand the viewport at the top. A cold channel (empty
    // cache) still shows the skeleton.
    isLoading: query.isLoading || (!anchorResolved && messages.length === 0),
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
  const queryKey = useMemo(() => {
    const baseKey = communityKeys.channelMessages(channelId ?? "__none__")
    return opts.tag ? [...baseKey, "tag", opts.tag] as const : baseKey
  }, [channelId, opts.tag])
  const queryFn = useMemo(
    () => channelMessagesQueryFn(channelId ?? "__none__", opts.tag),
    [channelId, opts.tag],
  )
  const base = useMessagesInner(
    channelId,
    queryKey,
    queryFn,
    opts,
  )
  const scope = useMemo<MessageScope>(() => ({
    kind: "channel",
    id: channelId ?? "__none__",
    serverId: opts.serverId,
  }), [channelId, opts.serverId])
  const overlay = useMessageOverlay(scope)
  const canonicalBase = useMemo(
    () => base.messages.filter(
      (message): message is CanonicalMessage => typeof message.seq === "number",
    ),
    [base.messages],
  )
  useEffect(() => {
    if (!channelId) return
    useMessageStreamStore.getState().dispatch(scope, {
      type: "baseChanged",
      messages: canonicalBase,
    })
  }, [canonicalBase, channelId, scope])
  const messages = useMemo(
    () => materializeMessageStream(canonicalBase, overlay).filter((message) =>
      messageMatchesTag(message, opts.tag)),
    [canonicalBase, opts.tag, overlay],
  )
  return { ...base, messages }
}

/**
 * DM-scoped sibling of `useMessages`. Same pagination shape, different route.
 */
export function useDmMessages(
  dmId: string | null,
  opts?: MessagesOpts,
): MessagesReturn {
  const queryKey = useMemo(
    () => communityKeys.dmMessages(dmId ?? "__none__"),
    [dmId],
  )
  const queryFn = useMemo(
    () => dmMessagesQueryFn(dmId ?? "__none__"),
    [dmId],
  )
  const base = useMessagesInner(
    dmId,
    queryKey,
    queryFn,
    opts,
  )
  const scope = useMemo<MessageScope>(() => ({
    kind: "dm",
    id: dmId ?? "__none__",
  }), [dmId])
  const overlay = useMessageOverlay(scope)
  const canonicalBase = useMemo(
    () => base.messages.filter(
      (message): message is CanonicalMessage => typeof message.seq === "number",
    ),
    [base.messages],
  )
  useEffect(() => {
    if (!dmId) return
    useMessageStreamStore.getState().dispatch(scope, {
      type: "baseChanged",
      messages: canonicalBase,
    })
  }, [canonicalBase, dmId, scope])
  const messages = useMemo(
    () => materializeMessageStream(canonicalBase, overlay),
    [canonicalBase, overlay],
  )
  return { ...base, messages }
}
