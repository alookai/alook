import type { InfiniteData, Query, QueryClient, QueryKey } from "@tanstack/react-query"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { ApiError } from "@/lib/errors"
import { captureChannelMetadataToken, isChannelMetadataTokenCurrent } from "@/hooks/community/channel-metadata"
import { communityKeys } from "@/lib/query-keys"
import { getMessageOverlay, useMessageStreamStore } from "@/stores/community/message-stream"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityMessages,
} from "@/lib/community-db/sync"
import type {
  MessagesPage,
  MessagesPageParam,
  Msg,
} from "@/lib/community/models/message"

type MessageCache = InfiniteData<MessagesPage, MessagesPageParam>

type WarmReconnectWindow = {
  cursor: string | null
  latestSeq: number
  pageParam: MessagesPageParam
  tag: string | null
}

const MAX_CATCH_UP_PAGES = 8

function isDefinitiveAccessDenial(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

function clearDeniedMessageScope(
  queryClient: QueryClient,
  kind: "channel" | "dm",
  scopeId: string,
) {
  useMessageStreamStore.getState().removeScope(
    kind === "channel"
      ? { kind, id: scopeId, serverId: "" }
      : { kind, id: scopeId },
  )
  queryClient.removeQueries({
    queryKey: kind === "channel"
      ? communityKeys.channelMessages(scopeId)
      : communityKeys.dmMessages(scopeId),
  })
}

function isMessageCache(value: unknown): value is MessageCache {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<MessageCache>
  return Array.isArray(candidate.pages) && Array.isArray(candidate.pageParams)
}

function compareMessages(a: Msg, b: Msg): number {
  const aCreatedAt = a.createdAt ?? ""
  const bCreatedAt = b.createdAt ?? ""
  if (aCreatedAt !== bCreatedAt) return aCreatedAt.localeCompare(bCreatedAt)
  return a.id.localeCompare(b.id)
}

function newestMessageCursor(cache: MessageCache): string | null {
  let newest: Msg | null = null
  for (const page of cache.pages) {
    for (const message of page.messages) {
      if (!message.createdAt) continue
      if (!newest || compareMessages(newest, message) < 0) newest = message
    }
  }
  return newest?.createdAt ? `${newest.createdAt}|${newest.id}` : null
}

function queryTag(queryKey: QueryKey): string | null {
  return queryKey[4] === "tag" && typeof queryKey[5] === "string"
    ? queryKey[5]
    : null
}

function buildMessagesUrl(
  scopeId: string,
  pageParam: MessagesPageParam,
  tag: string | null,
): string {
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
  const query = params.toString()
  const base = `/api/community/channels/${scopeId}/messages`
  return query ? `${base}?${query}` : base
}

function cachedLatestSeq(cache: MessageCache): number {
  return cache.pages.reduce((latest, page) => Math.max(
    latest,
    page.latestSeq ?? 0,
    ...page.messages.map((message) => message.seq ?? 0),
  ), 0)
}

function cachedMessageRowLatestSeq(cache: MessageCache): number {
  return cache.pages.reduce((latest, page) => Math.max(
    latest,
    ...page.messages.map((message) => message.seq ?? 0),
  ), 0)
}

type GapRepairScope = {
  kind: "channel" | "dm"
  scopeId: string
  serverId?: string
}

type FocusedQueryRepair = { promise: Promise<void>; settled: boolean }

type FocusedMessageRepair = {
  token: ReturnType<typeof captureChannelMetadataToken>
  queries: Map<Query, FocusedQueryRepair>
  promise: Promise<void>
  gapPromise: Promise<void>
  target: { seq: number }
}

const focusedMessageRepairs = new WeakMap<QueryClient, Map<string, FocusedMessageRepair>>()

function knownFocusedMessageSeq(
  queryClient: QueryClient,
  scope: GapRepairScope,
): number {
  const queryKey = scope.kind === "channel"
    ? communityKeys.channelMessages(scope.scopeId)
    : communityKeys.dmMessages(scope.scopeId)
  const queries = queryClient.getQueryCache().findAll({ queryKey, type: "active" })
  let latest = 0
  for (const query of queries) {
    if (isMessageCache(query.state.data)) {
      // `page.latestSeq` is a server watermark, not proof that the row is
      // present locally. Only concrete cached messages close a sequence gap.
      latest = Math.max(latest, cachedMessageRowLatestSeq(query.state.data))
    }
  }
  const overlay = scope.kind === "channel"
    ? getMessageOverlay({
        kind: "channel",
        id: scope.scopeId,
        serverId: scope.serverId ?? "",
      })
    : getMessageOverlay({ kind: "dm", id: scope.scopeId })
  for (const message of overlay.liveById.values()) {
    latest = Math.max(latest, message.seq ?? 0)
  }
  return latest
}

/**
 * Detect a missing focused message before the incoming frame is projected.
 * One repair runs per scope; later gap frames share the in-flight D1 catch-up.
 */
export function scheduleFocusedMessageGapRepair(
  queryClient: QueryClient,
  scope: GapRepairScope,
  incomingSeq: number,
): Promise<void> | null {
  if (incomingSeq <= knownFocusedMessageSeq(queryClient, scope) + 1) return null
  return getFocusedMessageRepair(queryClient, scope.kind, scope.scopeId, incomingSeq).gapPromise
}

/**
 * Classify an active query as a paint-preserving warm window or a cold query.
 *
 * A warm window always has a rendered page plus the page parameter that
 * produced it. Empty conversations are still warm: their empty newest page is
 * valuable UI state and must be refreshed in place. Undefined, failed, or
 * malformed data is cold and is recovered through the query's own fetch
 * function instead of inventing pagination state here.
 */
function warmReconnectWindow(
  queryKey: QueryKey,
  data: unknown,
): WarmReconnectWindow | null {
  if (!isMessageCache(data) || data.pages.length === 0) return null
  const pageParam = data.pageParams[0]
  if (!pageParam) return null
  return {
    cursor: newestMessageCursor(data),
    latestSeq: cachedLatestSeq(data),
    pageParam,
    tag: queryTag(queryKey),
  }
}

async function fetchCurrentWindow(
  scopeId: string,
  pageParam: MessagesPageParam,
  tag: string | null,
): Promise<MessagesPage> {
  return apiFetchProfiles<MessagesPage>(
    buildMessagesUrl(scopeId, pageParam, tag),
    (page) => messageProfilePatches(page.messages),
  )
}

async function fetchCatchUp(
  scopeId: string,
  cursor: string,
  tag: string | null,
  target: { seq: number },
): Promise<MessagesPage> {
  const messages: Msg[] = []
  let latestSeq = 0
  let nextCursor = cursor
  let hasMoreNewer = false
  let newerCursor: string | undefined

  for (let pageIndex = 0; pageIndex < MAX_CATCH_UP_PAGES; pageIndex += 1) {
    const params = new URLSearchParams({ since: nextCursor })
    if (tag) params.set("tag", tag)
    const page = await apiFetchProfiles<MessagesPage>(
      `/api/community/channels/${scopeId}/messages?${params}`,
      (response) => messageProfilePatches(response.messages),
    )
    messages.push(...page.messages)
    latestSeq = Math.max(latestSeq, page.latestSeq ?? 0)
    hasMoreNewer = page.hasMoreNewer ?? false
    newerCursor = page.newerCursor
    if (!hasMoreNewer || !newerCursor) {
      if (latestSeq < target.seq) continue
      break
    }
    nextCursor = newerCursor
  }

  return {
    messages,
    latestSeq,
    hasMoreNewer,
    newerCursor,
  }
}

function mergeReconciledPages(
  cache: MessageCache,
  refreshed: MessagesPage,
  catchUp: MessagesPage | null,
): MessageCache {
  if (cache.pages.length === 0) return cache

  const reconciled = catchUp
    ? [...refreshed.messages, ...catchUp.messages]
    : refreshed.messages
  const incoming = new Map(reconciled.map((message) => [message.id, message]))
  const pages = cache.pages.map((page) => ({
    ...page,
    messages: page.messages.map((message) => {
      const replacement = incoming.get(message.id)
      if (!replacement) return message
      incoming.delete(message.id)
      return replacement
    }),
  }))
  const first = pages[0]
  const messages = [...first.messages, ...incoming.values()].sort(compareMessages)
  pages[0] = {
    ...first,
    messages,
    latestSeq: Math.max(
      first.latestSeq ?? 0,
      refreshed.latestSeq ?? 0,
      catchUp?.latestSeq ?? 0,
    ),
    hasMoreNewer: catchUp?.hasMoreNewer ?? refreshed.hasMoreNewer ?? false,
    newerCursor: catchUp?.newerCursor ?? refreshed.newerCursor,
  }
  return { ...cache, pages }
}

function getFocusedMessageRepair(
  queryClient: QueryClient,
  kind: "channel" | "dm",
  scopeId: string,
  incomingSeq = 0,
): FocusedMessageRepair {
  const queryKey = kind === "channel"
    ? communityKeys.channelMessages(scopeId)
    : communityKeys.dmMessages(scopeId)
  const queries = queryClient.getQueryCache().findAll({
    queryKey,
    type: "active",
  })
  let repairs = focusedMessageRepairs.get(queryClient)
  if (!repairs) {
    repairs = new Map()
    focusedMessageRepairs.set(queryClient, repairs)
  }
  const key = `${kind}:${scopeId}`
  const previous = repairs.get(key)
  const reusable = previous && isChannelMetadataTokenCurrent(previous.token)
    ? previous
    : undefined
  const target = reusable?.target ?? { seq: 0 }
  target.seq = Math.max(target.seq, incomingSeq)
  if (reusable
    && reusable.queries.size === queries.length
    && queries.every((query) => {
      const operation = reusable.queries.get(query)
      return operation && !operation.settled
    })) return reusable
  const token = captureChannelMetadataToken(scopeId)
  const queryOperations = new Map<Query, FocusedQueryRepair>()
  for (const query of queries) {
    const existing = reusable?.queries.get(query)
    if (existing && !existing.settled) {
      queryOperations.set(query, existing)
      continue
    }
    const operation = (async () => {
      const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
      const isCurrent = () => isChannelMetadataTokenCurrent(token)
        && queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query
      // Infinite-query pagination computes its result from the data snapshot at
      // fetch start. If that generation completes after reconciliation, TanStack
      // can replace the reconciled cache with its stale snapshot. Capture the
      // user's pagination intent, cancel that exact generation, then replay the
      // same direction against the reconciled cache below.
      const pendingDirection = query.state.fetchStatus !== "idle"
        ? query.state.fetchMeta?.fetchMore?.direction
        : undefined
      await queryClient.cancelQueries(
        { queryKey: query.queryKey, exact: true },
        { revert: true, silent: true },
      )

      if (!isCurrent()) return
      let accessDenied = false
      let processedTarget = 0
      const refresh = async () => {
        let window = warmReconnectWindow(query.queryKey, query.state.data)
        if (!window) {
          await queryClient.refetchQueries(
            { queryKey: query.queryKey, exact: true, type: "active" },
            { throwOnError: true },
          )
          if (!isCurrent()) return
          window = warmReconnectWindow(query.queryKey, query.state.data)
          if (!window || target.seq <= window.latestSeq) {
            processedTarget = target.seq
            return
          }
        }
        let refreshed = await fetchCurrentWindow(
          scopeId,
          window.pageParam,
          window.tag,
        )
        if (!isCurrent()) return
        for (let attempt = 1; window.cursor === null
          && (refreshed.latestSeq ?? 0) < target.seq
          && attempt < MAX_CATCH_UP_PAGES; attempt += 1) {
          refreshed = await fetchCurrentWindow(scopeId, window.pageParam, window.tag)
          if (!isCurrent()) return
        }
        const catchUp = window.cursor !== null
          && Math.max(refreshed.latestSeq ?? 0, target.seq) > window.latestSeq
          ? await fetchCatchUp(scopeId, window.cursor, window.tag, target)
          : null
        if (!isCurrent()) return
        const coveredTarget = target.seq
        publishCommunityMessages(queryClient, {
          channelId: scopeId,
          messages: catchUp
            ? [...refreshed.messages, ...catchUp.messages]
            : refreshed.messages,
          proof: { token: publicationToken, signal: undefined },
        })
        queryClient.setQueryData<MessageCache>(query.queryKey, (current) => (
          isMessageCache(current)
            ? mergeReconciledPages(current, refreshed, catchUp)
            : current
        ))
        processedTarget = coveredTarget
      }
      const reconcile = async () => {
        try {
          await refresh()
        } catch (error) {
          if (!isCurrent()) return
          if (!isDefinitiveAccessDenial(error)) throw error
          accessDenied = true
          clearDeniedMessageScope(queryClient, kind, scopeId)
        }
      }
      try {
        await reconcile()
      } finally {
        try {
          if (pendingDirection && !accessDenied && isCurrent()) {
            await query.fetch(undefined, {
              meta: { fetchMore: { direction: pendingDirection } },
            })
          }
        } finally {
          if (!accessDenied && isCurrent() && target.seq > processedTarget) {
            await reconcile()
          }
        }
      }
    })()
    const queryRepair = { promise: operation, settled: false }
    queryOperations.set(query, queryRepair)
    void operation.then(
      () => { queryRepair.settled = true },
      () => { queryRepair.settled = true },
    )
  }
  const promise = Promise.allSettled([...queryOperations.values()].map((query) => query.promise)).then((settled) => {
    if (settled.some((result) => result.status === "rejected")) {
      throw new Error("focused messages failed")
    }
  })
  const repair: FocusedMessageRepair = {
    token,
    queries: queryOperations,
    promise,
    gapPromise: promise.catch(() => undefined),
    target,
  }
  repairs.set(key, repair)
  void promise.finally(() => {
    if (repairs.get(key) === repair) repairs.delete(key)
  }).catch(() => undefined)
  return repair
}

export function reconcileFocusedMessageQueries(
  queryClient: QueryClient,
  kind: "channel" | "dm",
  scopeId: string,
): Promise<void> {
  return getFocusedMessageRepair(queryClient, kind, scopeId).promise
}
