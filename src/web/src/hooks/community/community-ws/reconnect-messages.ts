import { CancelledError, hashKey, queryOptions, type InfiniteData, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken, publishCommunityMessages, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { ConversationReadTimeoutError, withConversationReadDeadline, isConversationAnchorMissingError } from "@/lib/community/conversation-read"
import { ApiError, isAbortError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { messageScopeKey } from "@/stores/community/message-stream-store"
import { messageWindowPage, type MessagesPage, type MessagesPageParam, type MessagesWindowPage } from "@/lib/community/models/message"
import { buildMessagesUrl, messageWindowIdentity } from "@/lib/community/message-window"

type MessageCache = InfiniteData<MessagesWindowPage, MessagesPageParam>
type GapRepairScope = { kind: "channel" | "dm"; scopeId: string; serverId?: string }
function isMessageCache(value: unknown): value is MessageCache { return !!value && typeof value === "object" && Array.isArray((value as MessageCache).pages) && Array.isArray((value as MessageCache).pageParams) }
function messagesKey(scope: GapRepairScope) { return scope.kind === "channel" ? communityKeys.channelMessages(scope.scopeId) : communityKeys.dmMessages(scope.scopeId) }
function targetKey(key: QueryKey) { return [...key, "reconcile-target"] }
function isWindowKey(key: QueryKey) { return messageWindowIdentity(key) !== undefined }
function latest(cache: MessageCache, includeWatermark = true) { return Math.max(0, ...cache.pages.flatMap((page) => [...page.messages.map((message) => message.seq ?? 0), ...(includeWatermark ? [page.latestSeq ?? 0] : [])])) }
function cursor(cache: MessageCache) { return cache.pages.flatMap((page) => page.newestCursor ? [page.newestCursor] : []).sort().at(-1) ?? null }
function url(scopeId: string, param: MessagesPageParam, tag: string | null) {
  return buildMessagesUrl(`/api/community/channels/${scopeId}/messages`, param, tag)
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

type MessageRepairOwner = { query: Query; signal: AbortSignal }
type MessageRepairReceipt = {
  token: ReturnType<typeof captureCommunityLiveSnapshotToken>
  window: Query | undefined
  scope: GapRepairScope
  key: QueryKey
  owner?: MessageRepairOwner
}

function repairReceipt(query: Query): MessageRepairReceipt | undefined {
  return query.meta?.communityMessageRepair as MessageRepairReceipt | undefined
}

function assertRepairCurrent(queryClient: QueryClient, receipt: MessageRepairReceipt, signal?: AbortSignal) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, receipt.token, signal)
  if (!receipt.window || queryClient.getQueryCache().find({ queryKey: receipt.key, exact: true }) !== receipt.window) {
    throw new DOMException("Retired message window", "AbortError")
  }
  if (receipt.window.isActive()) return
  const owner = receipt.owner
  if (!owner || owner.signal.aborted || queryClient.getQueryCache().get(owner.query.queryHash) !== owner.query
    || !owner.query.isActive() && owner.query.state.fetchStatus === "idle") {
    throw new DOMException("Retired message repair owner", "AbortError")
  }
}

export function isFailedMessageRepair(queryClient: QueryClient, query: Query): boolean {
  const receipt = repairReceipt(query)
  if (!receipt?.window?.isActive() || query.state.status !== "error" || query.state.fetchStatus !== "idle"
    || isAbortError(query.state.error) || query.state.error instanceof CancelledError
    || isConversationAnchorMissingError(query.state.error)) return false
  try { assertRepairCurrent(queryClient, receipt); return true } catch { return false }
}

export function cancelMessageRepairs(queryClient: QueryClient, inactiveOnly = false) {
  return queryClient.cancelQueries({ predicate: (query) => {
    const receipt = repairReceipt(query)
    if (!receipt || query.state.fetchStatus === "idle") return false
    if (!inactiveOnly) return true
    try { assertRepairCurrent(queryClient, receipt); return false } catch { return true }
  } })
}

export function retryFailedMessageRepairs(queryClient: QueryClient) {
  return Promise.all(queryClient.getQueryCache().getAll()
    .filter((query) => isFailedMessageRepair(queryClient, query))
    .map((query) => {
      const receipt = repairReceipt(query)!
      return reconcileWindow(queryClient, receipt.scope, receipt.key)
    }))
}

export function messageReconcileOptions(queryClient: QueryClient, scope: GapRepairScope, key: QueryKey, landing?: { page: MessagesPage; param: MessagesPageParam }, owner?: MessageRepairOwner) {
  const scopeId = scope.scopeId
  const token = captureCommunityLiveSnapshotToken(queryClient, scopeId), registry = getCommunityDbRegistry(queryClient)
  const channel = registry?.collections.channels.get(scopeId)
  const serverId = scope.kind === "dm" ? null : channel ? channel.serverId : scope.serverId
  const originalQuery = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  const receipt: MessageRepairReceipt = { token, window: originalQuery, scope, key, owner }
  const pendingDirection = originalQuery?.state.fetchStatus === "fetching" ? originalQuery.state.fetchMeta?.fetchMore?.direction : undefined
  let paginationReplayed = false
  let landingPage = landing
  let prefetched: { param: MessagesPageParam; page: MessagesPage } | undefined
  const repairKey: QueryKey = [...key, "reconcile"]
  return queryOptions({
    queryKey: repairKey, staleTime: 0,
    retry: (failureCount, error) => failureCount < 2 && (error instanceof ConversationReadTimeoutError
      || (error instanceof ApiError && [0, 500, 502, 503, 504].includes(error.status))),
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250),
    networkMode: "online",
    meta: { communityMessageRepair: receipt },
    queryFn: async ({ signal }) => {
      const assert = () => assertRepairCurrent(queryClient, receipt, signal)
      await registry?.ready
      assert()
      const data = originalQuery?.state.data
      if (!isMessageCache(data) || !data.pageParams[0]) return { latestSeq: 0 }
      await queryClient.cancelQueries({ queryKey: key, exact: true }, { revert: true, silent: true })
      assert()
      const tag = messageWindowIdentity(key)?.tag ?? null
      const load = async (param: MessagesPageParam) => {
        assert()
        const page = await withConversationReadDeadline(signal, (readSignal) => apiFetchCommunity<MessagesPage>(
          url(scopeId, param, tag), { signal: readSignal, assertActive: assert }, token,
        ))
        assert()
        return page
      }
      const target = () => queryClient.getQueryData<number>(targetKey(key)) ?? 0
      const prefetch = async (current: MessageCache, refreshed: MessagesPage) => {
        if (prefetched || Math.max(refreshed.latestSeq ?? 0, target()) <= latest(current, false)) return
        const nextCursor = cursor(current)
        if (!nextCursor && (refreshed.latestSeq ?? 0) >= target()) return
        const param: MessagesPageParam = nextCursor ? { mode: "since", since: nextCursor } : current.pageParams[0]
        prefetched = { param, page: await load(param) }
      }
      const publish = (refreshed: MessagesPage) => {
        assert()
        const catchUp = prefetched ? [prefetched.page] : []
        publishCommunityMessages(queryClient, { channelId: scopeId, messages: [refreshed, ...catchUp].flatMap((page) => page.messages), proof: { token, signal } })
        queryClient.setQueryData<MessageCache>(key, (cache) => isMessageCache(cache) ? mergeWindow(cache, refreshed, catchUp) : cache)
      }
      try {
        const current = originalQuery?.state.data
        if (!isMessageCache(current) || !current.pageParams[0]) return { latestSeq: 0 }
        if (!landingPage || hashKey([landingPage.param]) !== hashKey([current.pageParams[0]])) {
          landingPage = { param: current.pageParams[0], page: await load(current.pageParams[0]) }
        }
        const refreshed = landingPage.page
        if (!isMessageCache(originalQuery?.state.data)) return { latestSeq: 0 }
        await prefetch(current, refreshed)
        publish(refreshed)
        if (pendingDirection && !paginationReplayed) {
          paginationReplayed = true
          await originalQuery?.fetch(undefined, { meta: { fetchMore: { direction: pendingDirection } } })
          assert()
        }
        const afterPagination = originalQuery?.state.data
        if (!prefetched && isMessageCache(afterPagination) && target() > latest(afterPagination, false)) {
          await prefetch(afterPagination, refreshed)
          publish(refreshed)
        }
        assert()
        const latestSeq = Math.max(refreshed.latestSeq ?? 0, prefetched?.page.latestSeq ?? 0)
        if (latestSeq < target() && !(prefetched?.page.hasMoreNewer && prefetched.page.newerCursor)) {
          throw new Error("Messages have not caught up yet")
        }
        return { latestSeq }
      } catch (error) {
        assert()
        if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 404) || isConversationAnchorMissingError(error)) throw error
        if (registry) retireCommunityChannelReading(registry, scopeId, {
          reason: "read-denied", serverId,
          preserveQuery: queryClient.getQueryCache().find({ queryKey: [...key, "reconcile"], exact: true }),
        })
        return { latestSeq: 0 }
      }
    },
  })
}

export function reconcileWindow(queryClient: QueryClient, scope: GapRepairScope, key: QueryKey, target = 0, landing?: { page: MessagesPage; param: MessagesPageParam }, owner?: MessageRepairOwner) {
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
  if (!query) return Promise.resolve()
  queryClient.setQueryData<number>(targetKey(key), (current) => Math.max(current ?? 0, target))
  if (!isMessageCache(query.state.data)) return query.fetch().then(() => undefined)
  const repairKey = [...key, "reconcile"]
  const repair = queryClient.getQueryCache().find({ queryKey: repairKey, exact: true })
  const receipt = repair && repairReceipt(repair)
  if (receipt) {
    let current = receipt.window === query
    try { assertRepairCurrent(queryClient, receipt) } catch { current = false }
    if (!current) queryClient.removeQueries({ queryKey: repairKey, exact: true })
    else if (repair.state.fetchStatus !== "idle" && repair.promise) {
      return repair.promise.then(() => undefined).catch((error: unknown) => {
        if (!isAbortError(error) && !(error instanceof CancelledError)) throw error
      })
    }
  }
  const options = messageReconcileOptions(queryClient, scope, key, landing, owner)
  const cancelRetiredOwner = () => {
    const current = queryClient.getQueryCache().find({ queryKey: repairKey, exact: true })
    if (current?.meta?.communityMessageRepair === options.meta?.communityMessageRepair && !query.isActive()) {
      void queryClient.cancelQueries({ queryKey: repairKey, exact: true })
    }
  }
  owner?.signal.addEventListener("abort", cancelRetiredOwner, { once: true })
  return queryClient.query({ ...options, select: undefined }).then(() => undefined).catch((error: unknown) => {
    if (!isAbortError(error) && !(error instanceof CancelledError)) throw error
  }).finally(() => {
    owner?.signal.removeEventListener("abort", cancelRetiredOwner)
    const current = queryClient.getQueryCache().find({ queryKey: repairKey, exact: true })
    if (current?.meta?.communityMessageRepair === options.meta?.communityMessageRepair && current?.state.status !== "error") {
      queryClient.removeQueries({ queryKey: targetKey(key), exact: true })
    }
  })
}

export function reconcileConversationLanding(queryClient: QueryClient, scope: GapRepairScope, key: QueryKey, page: MessagesPage, param: MessagesPageParam, owner: MessageRepairOwner) {
  const data = queryClient.getQueryData(key)
  const highWater = page.latestSeq ?? 0
  if (!isMessageCache(data) || highWater <= latest(data)) return Promise.resolve()
  return reconcileWindow(queryClient, scope, key, highWater, { page, param }, owner)
}

function reconcile(queryClient: QueryClient, scope: GapRepairScope, target = 0) {
  const queries = queryClient.getQueryCache().findAll({ queryKey: messagesKey(scope), type: "active" }).filter((query) => isWindowKey(query.queryKey))
  return Promise.all(queries.map(query => reconcileWindow(queryClient, scope, query.queryKey, target))).then(() => undefined)
}

export function scheduleFocusedMessageGapRepair(queryClient: QueryClient, scope: GapRepairScope, incomingSeq: number): Promise<void> | null {
  const queries = queryClient.getQueryCache().findAll({ queryKey: messagesKey(scope), type: "active" }).filter((query) => isWindowKey(query.queryKey))
  const windowSeq = Math.max(0, ...queries.flatMap((query) => isMessageCache(query.state.data) ? [latest(query.state.data, false)] : []))
  const ids = getCommunityRuntime(queryClient).messageStream.get().entries.get(messageScopeKey({ kind: scope.kind, id: scope.scopeId }))?.state.liveIds ?? []
  const messages = getCommunityDbRegistry(queryClient)?.collections.messages
  const known = Math.max(windowSeq, ...ids.map((id) => messages?.get(id)?.seq ?? 0), 0)
  return incomingSeq > known + 1 ? reconcile(queryClient, scope, incomingSeq).catch(() => undefined) : null
}

export function reconcileFocusedMessageQueries(queryClient: QueryClient, kind: "channel" | "dm", scopeId: string, serverId?: string): Promise<void> { return reconcile(queryClient, { kind, scopeId, serverId }) }
