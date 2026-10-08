import { CancelledError, queryOptions, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityMessages } from "@/lib/community-db/sync"
import { ApiError, isAbortError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { messageScopeKey } from "@/stores/community/message-stream-store"
import { messageWindowPage, type MessagesPage, type MessagesPageParam, type MessagesWindowPage } from "@/lib/community/models/message"

type MessageCache = InfiniteData<MessagesWindowPage, MessagesPageParam>
type GapRepairScope = { kind: "channel" | "dm"; scopeId: string; serverId?: string }
const MAX_CATCH_UP_PAGES = 8
function isMessageCache(value: unknown): value is MessageCache { return !!value && typeof value === "object" && Array.isArray((value as MessageCache).pages) && Array.isArray((value as MessageCache).pageParams) }
function messagesKey(scope: GapRepairScope) { return scope.kind === "channel" ? communityKeys.channelMessages(scope.scopeId) : communityKeys.dmMessages(scope.scopeId) }
function targetKey(key: QueryKey) { return [...key, "reconcile-target"] }
function isWindowKey(key: QueryKey) { return key.length === 4 || key.length === 6 && key[4] === "tag" }
function latest(cache: MessageCache, includeWatermark = true) { return Math.max(0, ...cache.pages.flatMap((page) => [...page.messages.map((message) => message.seq ?? 0), ...(includeWatermark ? [page.latestSeq ?? 0] : [])])) }
function cursor(cache: MessageCache) { return cache.pages.flatMap((page) => page.newestCursor ? [page.newestCursor] : []).sort().at(-1) ?? null }
function url(scopeId: string, param: MessagesPageParam, tag: string | null) {
  const search = new URLSearchParams()
  if (tag) search.set("tag", tag)
  if (param.mode === "anchor") search.set("anchor", param.anchor)
  if (param.mode === "older") search.set("cursor", param.cursor)
  if (param.mode === "since") search.set("since", param.since)
  if (param.mode === "newer") search.set("since", param.cursor)
  return `/api/community/channels/${scopeId}/messages${search.size ? `?${search}` : ""}`
}

function mergeWindow(cache: MessageCache, refreshed: MessagesPage, catchUp: MessagesPage[]): MessageCache {
  if (!cache.pages.length) return cache
  const incoming = new Map(messageWindowPage({ ...refreshed, messages: [refreshed, ...catchUp].flatMap((page) => page.messages) }).messages.map((message) => [message.id, message]))
  const pages = cache.pages.map((page) => ({ ...page, messages: page.messages.map((message) => { const replacement = incoming.get(message.id); incoming.delete(message.id); return replacement ?? message }) }))
  const newest = catchUp.at(-1) ?? refreshed
  const window = messageWindowPage(newest)
  pages[0] = { ...pages[0], messages: [...pages[0].messages, ...incoming.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), latestSeq: Math.max(latest(cache), refreshed.latestSeq ?? 0, ...catchUp.map((page) => page.latestSeq ?? 0)), hasMoreNewer: newest.hasMoreNewer ?? false, newerCursor: newest.newerCursor, newestCursor: [pages[0].newestCursor, window.newestCursor].filter((value): value is string => !!value).sort().at(-1) }
  return { ...cache, pages }
}

export function messageReconcileOptions(queryClient: QueryClient, scopeId: string, key: QueryKey) {
  const token = captureCommunityLiveSnapshotToken(queryClient, scopeId), registry = getCommunityDbRegistry(queryClient)
  const originalQuery = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  const receipt = { token, window: originalQuery }
  return queryOptions({
    queryKey: [...key, "reconcile"], staleTime: 0, retry: false,
    meta: { communityMessageRepair: receipt },
    queryFn: async ({ signal }) => {
      const assert = () => { assertCommunityLiveSnapshotTokenCurrent(queryClient, token, signal); if (queryClient.getQueryCache().find({ queryKey: key, exact: true }) !== originalQuery) throw new DOMException("Retired message window", "AbortError") }
      await registry?.ready
      assert()
      const data = originalQuery?.state.data
      if (!isMessageCache(data) || !data.pageParams[0]) return { latestSeq: 0 }
      const pendingDirection = originalQuery?.state.fetchStatus === "fetching" ? originalQuery.state.fetchMeta?.fetchMore?.direction : undefined
      await queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: true, silent: true })
      assert()
      const tag = key[4] === "tag" && typeof key[5] === "string" ? key[5] : null
      const load = async (param: MessagesPageParam) => { assert(); const page = await apiFetchCommunity<MessagesPage>(url(scopeId, param, tag), { signal, assertActive: assert }, token); assert(); return page }
      let highWater = latest(data)
      let paginationReplayed = false
      try {
        for (let pass = 0; pass < MAX_CATCH_UP_PAGES; pass++) {
          const target = () => queryClient.getQueryData<number>(targetKey(key)) ?? 0
          const current = originalQuery?.state.data
          if (!isMessageCache(current) || !current.pageParams[0]) return { latestSeq: highWater }
          const refreshed = await load(current.pageParams[0]), catchUp: MessagesPage[] = []
          if (!isMessageCache(originalQuery?.state.data)) return { latestSeq: highWater }
          let nextCursor = cursor(current)
          highWater = Math.max(highWater, refreshed.latestSeq ?? 0)
          for (let pageIndex = 0; nextCursor && pageIndex < MAX_CATCH_UP_PAGES && (highWater > latest(current) || target() > highWater); pageIndex++) {
            const page = await load({ mode: "since", since: nextCursor })
            catchUp.push(page)
            highWater = Math.max(highWater, page.latestSeq ?? 0)
            if (!page.hasMoreNewer || !page.newerCursor) { if (highWater < target()) continue; break }
            nextCursor = page.newerCursor
          }
          assert()
          publishCommunityMessages(queryClient, { channelId: scopeId, messages: [refreshed, ...catchUp].flatMap((page) => page.messages), proof: { token, signal } })
          queryClient.setQueryData<MessageCache>(key, (cache) => isMessageCache(cache) ? mergeWindow(cache, refreshed, catchUp) : cache)
          if (pendingDirection && !paginationReplayed) {
            paginationReplayed = true
            await originalQuery?.fetch(undefined, { meta: { fetchMore: { direction: pendingDirection } } })
            assert()
          }
          if (highWater >= (queryClient.getQueryData<number>(targetKey(key)) ?? 0)) break
        }
        assert()
        return { latestSeq: highWater }
      } catch (error) {
        assert()
        if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404)) throw error
        const kind = key[1] === "dm" ? "dm" : "channel"
        getCommunityRuntime(queryClient).messageStream.actions.removeScope(kind === "dm" ? { kind, id: scopeId } : { kind, id: scopeId, serverId: "" })
        queryClient.removeQueries({ queryKey: key, exact: true })
        return { latestSeq: 0 }
      } finally {
        const repair = queryClient.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true })
        if (repair?.meta?.communityMessageRepair === receipt) queryClient.removeQueries({ queryKey: targetKey(key), exact: true })
      }
    },
  })
}

function reconcile(queryClient: QueryClient, scope: GapRepairScope, target = 0) {
  const queries = queryClient.getQueryCache().findAll({ queryKey: messagesKey(scope), type: "active" }).filter((query) => isWindowKey(query.queryKey))
  return Promise.all(queries.map((query) => {
    queryClient.setQueryData<number>(targetKey(query.queryKey), (current) => Math.max(current ?? 0, target))
    if (!isMessageCache(query.state.data)) return query.fetch()
    const repairKey = [...query.queryKey, "reconcile"]
    const repair = queryClient.getQueryCache().find({ queryKey: repairKey, exact: true })
    const receipt = repair?.meta?.communityMessageRepair as { token: ReturnType<typeof captureCommunityLiveSnapshotToken>; window: typeof query } | undefined
    if (receipt) {
      let current = receipt.window === query
      try { assertCommunityLiveSnapshotTokenCurrent(queryClient, receipt.token, undefined) } catch { current = false }
      if (!current) queryClient.removeQueries({ queryKey: repairKey, exact: true })
    }
    return queryClient.query({ ...messageReconcileOptions(queryClient, scope.scopeId, query.queryKey), select: undefined }).catch((error: unknown) => {
      if (!isAbortError(error) && !(error instanceof CancelledError)) throw error
    })
  })).then(() => undefined)
}

export function scheduleFocusedMessageGapRepair(queryClient: QueryClient, scope: GapRepairScope, incomingSeq: number): Promise<void> | null {
  const queries = queryClient.getQueryCache().findAll({ queryKey: messagesKey(scope), type: "active" }).filter((query) => isWindowKey(query.queryKey))
  const windowSeq = Math.max(0, ...queries.flatMap((query) => isMessageCache(query.state.data) ? [latest(query.state.data, false)] : []))
  const ids = getCommunityRuntime(queryClient).messageStream.get().entries.get(messageScopeKey({ kind: scope.kind, id: scope.scopeId }))?.state.liveIds ?? []
  const messages = getCommunityDbRegistry(queryClient)?.collections.messages
  const known = Math.max(windowSeq, ...ids.map((id) => messages?.get(id)?.seq ?? 0), 0)
  return incomingSeq > known + 1 ? reconcile(queryClient, scope, incomingSeq).catch(() => undefined) : null
}

export function reconcileFocusedMessageQueries(queryClient: QueryClient, kind: "channel" | "dm", scopeId: string): Promise<void> { return reconcile(queryClient, { kind, scopeId }) }
