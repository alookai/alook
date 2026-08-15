import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
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
  return apiFetch<MessagesPage>(buildMessagesUrl(scopeId, pageParam, tag))
}

async function fetchCatchUp(
  scopeId: string,
  cursor: string,
  tag: string | null,
): Promise<MessagesPage> {
  const messages: Msg[] = []
  let latestSeq = 0
  let nextCursor = cursor
  let hasMoreNewer = false
  let newerCursor: string | undefined

  for (let pageIndex = 0; pageIndex < MAX_CATCH_UP_PAGES; pageIndex += 1) {
    const params = new URLSearchParams({ since: nextCursor })
    if (tag) params.set("tag", tag)
    const page = await apiFetch<MessagesPage>(
      `/api/community/channels/${scopeId}/messages?${params}`,
    )
    messages.push(...page.messages)
    latestSeq = Math.max(latestSeq, page.latestSeq ?? 0)
    hasMoreNewer = page.hasMoreNewer ?? false
    newerCursor = page.newerCursor
    if (!hasMoreNewer || !newerCursor) break
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

export async function reconcileFocusedMessageQueries(
  queryClient: QueryClient,
  kind: "channel" | "dm",
  scopeId: string,
): Promise<void> {
  const queryKey = kind === "channel"
    ? communityKeys.channelMessages(scopeId)
    : communityKeys.dmMessages(scopeId)
  const queries = queryClient.getQueryCache().findAll({
    queryKey,
    type: "active",
  })
  const operations = queries.map(async (query) => {
    // Infinite-query pagination computes its result from the data snapshot at
    // fetch start. If that generation completes after reconciliation, TanStack
    // can replace the reconciled cache with its stale snapshot. Capture the
    // user's pagination intent, cancel that exact generation, then replay the
    // same direction against the reconciled cache below.
    const pendingDirection = query.state.fetchMeta?.fetchMore?.direction
    await queryClient.cancelQueries(
      { queryKey: query.queryKey, exact: true },
      { revert: true, silent: true },
    )

    const window = warmReconnectWindow(query.queryKey, query.state.data)
    if (!window) {
      // There is no painted history to protect. Delegate recovery to the
      // query's canonical queryFn so cold/failed active screens do not remain
      // stuck after `refetchOnReconnect` is intentionally disabled.
      await queryClient.refetchQueries(
        { queryKey: query.queryKey, exact: true, type: "active" },
        { throwOnError: true },
      )
      return
    }

    try {
      const refreshed = await fetchCurrentWindow(
        scopeId,
        window.pageParam,
        window.tag,
      )
      const catchUp = window.cursor !== null
        && (refreshed.latestSeq ?? 0) > window.latestSeq
        ? await fetchCatchUp(scopeId, window.cursor, window.tag)
        : null
      queryClient.setQueryData<MessageCache>(query.queryKey, (current) => (
        isMessageCache(current)
          ? mergeReconciledPages(current, refreshed, catchUp)
          : current
      ))
    } finally {
      if (pendingDirection) {
        await query.fetch(undefined, {
          meta: { fetchMore: { direction: pendingDirection } },
        })
      }
    }
  })
  const settled = await Promise.allSettled(operations)
  if (settled.some((result) => result.status === "rejected")) {
    throw new Error("focused messages failed")
  }
}
