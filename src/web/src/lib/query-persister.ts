import { forumSidebarWindowComplete, isForumSidebarWindowKey, readForumSidebarWindowResult } from "@/lib/community/forum-sidebar-window"
import { messageProfileIds, type Msg } from "@/lib/community/models/message"
import { clearLegacyChatCaches, getLegacyChatCacheSizeBytes } from "@/lib/legacy-chat-persistence"
import { clearPublicWorkerCaches, getPublicWorkerCacheSizeBytes } from "@/lib/service-worker/public-cache-storage"
import { observeRestoreRead, observeRestoreDecode } from "@/lib/observability/restore"
import { createStore as createNativeStore } from "@tanstack/store"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { createStore, promisifyRequest } from "idb-keyval"
import { isCommunityListResourceKey, persistentCommunityListResource } from "@/lib/community/list-persistence"
import {
  communityCollectionSchemas,
  type CommunityCollectionName,
  type CommunityCollectionRows,
} from "@/lib/community-db/schema"

export const PERSIST_VERSION = 6
export const PERSIST_BUSTER = String(PERSIST_VERSION)
export const PERSIST_CACHE_PREFIX = "alook:qc:cache"
const IDB_PREFIX = PERSIST_CACHE_PREFIX

/** Persister max-age; queries older than this are discarded on restore. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

export const MAX_PERSISTED_MESSAGE_SCOPES = 20
export const MAX_PERSISTED_MESSAGES_PER_SCOPE = 50
const MAX_PERSISTED_ATTENTION_ITEMS = 200

function isCommunityDbCollectionKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === "community"
    && queryKey[1] === "db"
    && queryKey.length === 4
    && typeof queryKey[2] === "string"
    && typeof queryKey[3] === "string"
  )
}

export function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  return isCommunityDbCollectionKey(queryKey) || isCommunityListResourceKey(queryKey) || isForumSidebarWindowKey(queryKey)
}

export function shouldPersistQuery(
  queryKey: readonly unknown[],
  data: unknown,
): boolean {
  return isCommunityDbCollectionKey(queryKey) || persistentCommunityListResource(queryKey, data) !== undefined
    || isForumSidebarWindowKey(queryKey) && readForumSidebarWindowResult(data)?.window.serverId === queryKey[2]
}

export function shouldDehydrateCommunityQuery(query: { queryKey: readonly unknown[]; state: { status: string; data: unknown } }) {
  return (query.state.status === "success" || isForumSidebarWindowKey(query.queryKey))
    && shouldPersistQuery(query.queryKey, query.state.data)
}

export type CommunityRestoredCollections = Partial<{
  [N in CommunityCollectionName]: { rows: CommunityCollectionRows[N][]; updatedAt: number }
}>

export function readCommunityRestoredCollections(snapshot: PersistedClient | undefined, userId: string | null): CommunityRestoredCollections {
  const collections: CommunityRestoredCollections = {}
  if (!userId || !snapshot) return collections
  for (const query of snapshot.clientState.queries) {
    if (!isCommunityDbCollectionKey(query.queryKey) || query.queryKey[2] !== userId) continue
    const name = query.queryKey[3] as CommunityCollectionName
    const schema = communityCollectionSchemas[name]
    if (!schema) continue
    const parsed = schema.array().safeParse(query.state.data)
    if (!parsed.success) continue
    const rows = name === "servers" ? parsed.data.map((row, position) => ({ ...row, position: (row as CommunityCollectionRows["servers"]).position ?? position })) : parsed.data
    Object.assign(collections, { [name]: { rows, updatedAt: query.state.dataUpdatedAt } })
  }
  return collections
}

export function createCommunityRestorePersister(original: Persister, userId: string | null) {
  let collections: CommunityRestoredCollections = {}
  const takeCollections = () => {
    const input = collections
    collections = {}
    return input
  }
  const persister: Persister = {
    persistClient: (client) => original.persistClient(client),
    restoreClient: async () => {
      collections = {}
      const restored = await original.restoreClient()
      collections = readCommunityRestoredCollections(restored, userId)
      return restored && { ...restored, clientState: {
        ...restored.clientState,
        queries: restored.clientState.queries.filter((query) => !isCommunityDbCollectionKey(query.queryKey)),
      } }
    },
    removeClient: () => { collections = {}; return original.removeClient() },
  }
  return { persister, takeCollections }
}

/**
 * Retain the bounded canonical read closure without mutating the live cache.
 */
function scrubDehydratedClient(
  client: PersistedClient,
  userId: string | null,
  retired: ReadonlyMap<string, ChannelDiskFence> = new Map(),
): PersistedClient {
  const queries: typeof client.clientState.queries = []
  const canonical = new Map<CommunityCollectionName, unknown[]>()
  for (const q of client.clientState.queries) {
    if (userId) {
      const data = persistentCommunityListResource(q.queryKey, q.state.data)
      if (data) queries.push({ ...q, state: { ...q.state, data } })
    }
    if (isCommunityDbCollectionKey(q.queryKey)) {
      if (!userId || q.queryKey[2] !== userId) continue
      const collectionName = q.queryKey[3] as CommunityCollectionName
      const schema = communityCollectionSchemas[collectionName]
      if (!schema) continue
      const parsed = schema.array().safeParse(q.state.data)
      if (!parsed.success) continue
      canonical.set(collectionName, parsed.data)
      continue
    }
  }

  const rows = <N extends CommunityCollectionName>(name: N) => (canonical.get(name) ?? []) as CommunityCollectionRows[N][]
  const retainedServerIds = new Set(rows("servers").map((row) => row.id))
  const channels = rows("channels").flatMap((row) => {
    const fence = retired.get(row.id)
    if (!fence) return [row]
    return row.type === "dm" && !fence.deleted
      ? [{ ...row, preview: "", unread: false, baseUnread: false, lastUnreadSeq: undefined }]
      : []
  })
  const attentionScopes = rows("attentionScopes").filter((row) => !retired.has(row.channelId))
  const attentionCandidates = rows("attentionItems").filter((row) => !Boolean(row.scopeId && retired.has(row.scopeId) || row.childChannelId && retired.has(row.childChannelId) || row.readTarget && retired.has(row.readTarget.channelId)))
  const retainedAttentionItems = [
    ...attentionCandidates.filter((item) => item.kind !== "friend_request")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, MAX_PERSISTED_ATTENTION_ITEMS),
    ...attentionCandidates.filter((item) => item.kind === "friend_request"),
  ]
  const attentionChannelIds = new Set(attentionScopes.map((row) => row.channelId))
  const retainedChannels = channels.filter((row) => (
    attentionChannelIds.has(row.id)
      || row.serverId === null
      || row.serverId === undefined
      || retainedServerIds.has(row.serverId)
  ))
  const retainedChannelIds = new Set(retainedChannels.map((row) => row.id))
  const retainedDmIds = new Set(
    retainedChannels.filter((row) => row.type === "dm").map((row) => row.id),
  )
  const allMessages = (rows("messages") as Array<CommunityCollectionRows["messages"] & Pick<Msg, "replyTo" | "thread" | "approval">>)
    .filter((row) => !retired.has(row.channelId))
  const messagesByScope = new Map<string, typeof allMessages>()
  for (const message of allMessages) {
    if (!retainedChannelIds.has(message.channelId)) continue
    const rows = messagesByScope.get(message.channelId) ?? []
    rows.push(message)
    messagesByScope.set(message.channelId, rows)
  }
  const compareMessagesNewest = (a: typeof allMessages[number], b: typeof allMessages[number]) => (
    (b.seq ?? -1) - (a.seq ?? -1)
    || String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))
    || b.id.localeCompare(a.id)
  )
  const attentionMessageIds = new Set(retainedAttentionItems.flatMap((row) => (
    row.messageId ? [row.messageId] : []
  )))
  const retainedMessages = [...messagesByScope.values()]
    .map((rows) => rows.slice().sort(compareMessagesNewest))
    .sort((a, b) => compareMessagesNewest(a[0]!, b[0]!))
    .slice(0, MAX_PERSISTED_MESSAGE_SCOPES)
    .flatMap((rows) => rows.slice(0, MAX_PERSISTED_MESSAGES_PER_SCOPE))
  const retainedMessageIds = new Set(retainedMessages.map((row) => row.id))
  for (const message of allMessages) {
    if (attentionMessageIds.has(message.id) && !retainedMessageIds.has(message.id)) {
      retainedMessages.push(message)
      retainedMessageIds.add(message.id)
    }
  }
  const retainedMessageChannelIds = new Set(retainedMessages.map((row) => row.channelId))
  const durableChannelIds = new Set([...retainedChannelIds, ...retainedMessageChannelIds])
  const retainedServerMemberships = rows("serverMemberships").filter((row) => row.viewer)
  const channelMemberships = rows("channelMemberships")
  const retainedChannelMemberships = channelMemberships.filter((row) => (
    durableChannelIds.has(row.channelId)
      && (
        row.userId === userId
        || row.relation === "access" && retainedDmIds.has(row.channelId)
      )
  ))
  const referencedProfileIds = new Set<string>(userId ? [userId] : [])
  for (const query of queries) if (query.queryKey[1] === "bots") {
    for (const bot of (query.state.data as { bots: Array<{ id: string }> }).bots) referencedProfileIds.add(bot.id)
  }
  for (const server of rows("servers")) {
    if (server.ownerId) referencedProfileIds.add(server.ownerId)
  }
  for (const membership of retainedServerMemberships) referencedProfileIds.add(membership.userId)
  for (const membership of retainedChannelMemberships) referencedProfileIds.add(membership.userId)
  for (const message of retainedMessages) {
    for (const id of messageProfileIds(message)) referencedProfileIds.add(id)
  }
  for (const item of retainedAttentionItems) if (item.actorUserId) referencedProfileIds.add(item.actorUserId)

  const windowed: Partial<Record<CommunityCollectionName, unknown[]>> = {
    ...Object.fromEntries(canonical),
    categories: rows("categories").filter(
      (row) => retainedServerIds.has(row.serverId),
    ),
    channels: retainedChannels,
    serverMemberships: retainedServerMemberships,
    channelMemberships: retainedChannelMemberships,
    messages: retainedMessages,
    readStates: rows("readStates").filter((row) => !retired.has(row.channelId)),
    notificationSettings: rows("notificationSettings").filter((row) => !row.channelId || !retired.has(row.channelId)),
    attentionScopes,
    attentionItems: retainedAttentionItems,
    profiles: rows("profiles").filter(
      (row) => referencedProfileIds.has(row.id),
    ),
  }
  for (const q of client.clientState.queries) {
    if (!isCommunityDbCollectionKey(q.queryKey)) continue
    if (!userId || q.queryKey[2] !== userId) continue
    const collectionName = q.queryKey[3] as CommunityCollectionName
    const data = windowed[collectionName]
    if (data) queries.push({ ...q, state: { ...q.state, data } })
  }
  const retiredServerIds = new Set(rows("channels").filter(row => retired.has(row.id)).map(row => row.serverId))
  for (const q of client.clientState.queries) {
    if (!userId || !isForumSidebarWindowKey(q.queryKey)) continue
    const data = readForumSidebarWindowResult(q.state.data)
    if (!data || data.window.serverId !== q.queryKey[2] || retiredServerIds.has(data.window.serverId)
      || data.window.parents.some(id => retired.has(id))
      || [...data.window.base, ...(data.window.retained?.disposition === "eligible" ? [data.window.retained.reference] : [])].some(row => retired.has(row.id) || retired.has(row.parentChannelId))
      || !forumSidebarWindowComplete(data.window, { servers: rows("servers"), channels: retainedChannels, channelMemberships: retainedChannelMemberships, messages: retainedMessages }, userId, data.window.serverId, null, Date.now() + data.serverClockOffsetMs)) continue
    queries.push({ ...q, state: { ...q.state, data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  return {
    ...client,
    clientState: { ...client.clientState, queries },
  }
}

/** IDB key namespace for a given user. `null` = pre-auth or logged out. */
function namespaceFor(userId: string | null): string {
  return `${IDB_PREFIX}:${userId ?? "anon"}`
}

/** Storage sub-key for the persister blob within a user's namespace. */
type PersistDomain = "community" | "application"
export const CACHE_INVALIDATION_STORAGE_KEY = "alook:qc:invalidation"
export const cacheInvalidation = createNativeStore(0)
function publishCacheInvalidation() {
  cacheInvalidation.setState((version) => version + 1)
  try { if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_INVALIDATION_STORAGE_KEY, crypto.randomUUID()) } catch {}
}
export type QualifiedPersister = Persister & { isCurrent: () => Promise<boolean>; retireAccount: () => Promise<void>; retireChannels: (ids: Iterable<string>, deleted?: boolean) => Promise<void> }
function blobKeyFor(userId: string | null, domain: PersistDomain = "community"): string {
  return `${namespaceFor(userId)}${domain === "application" ? ":application" : ""}:client`
}

function isPersistedCacheBlobKey(key: IDBValidKey): key is string {
  return typeof key === "string" && /^alook:qc:[^:]+:[^:]+(?::application)?:client$/.test(key)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${Number(value.toFixed(1))} ${units[unitIndex]}`
}

// Reuse idb-keyval's existing database and native transaction serialization.
// No document-local lock can fence a writer in another tab.
const cacheStore = createStore("keyval-store", "keyval")
const DEVICE_EPOCH_KEY = "alook:qc:device-epoch"
const scopeEpochKey = (key: string) => `${key}:epoch`
const accountEpochKey = (userId: string | null) => `${namespaceFor(userId)}:account-epoch`
type ChannelDiskFence = { epoch: string; deleted: boolean }
type PersistEligibility = { device: string; scope: string; account: string; channels: Map<string, ChannelDiskFence> }
const channelFenceKey = (userId: string | null) => `${accountEpochKey(userId)}:channels`
const isChannelFences = (value: unknown): value is Map<string, ChannelDiskFence> => (
  value instanceof Map && [...value].every(([id, fence]) => typeof id === "string" && id.length > 0
    && fence !== null && typeof fence === "object" && isEpoch(fence.epoch) && typeof fence.deleted === "boolean")
)
function changedChannelFences(current: Map<string, ChannelDiskFence>, expected: Map<string, ChannelDiskFence>) {
  return new Map([...current].filter(([id, fence]) => fence.epoch !== expected.get(id)?.epoch))
}
function decodeDiskSnapshot(raw: unknown) {
  try {
    if (typeof raw !== "string") return undefined
    const { version, channelFences, ...snapshot } = JSON.parse(raw) as PersistedClient & { version?: unknown; channelFences?: unknown }
    if (version !== PERSIST_VERSION || snapshot.buster !== PERSIST_BUSTER || !Array.isArray(channelFences)
      || !channelFences.every((entry) => Array.isArray(entry) && entry.length === 2)) return undefined
    const fences = new Map(channelFences)
    return isChannelFences(fences) ? { snapshot, fences } : undefined
  } catch { return undefined }
}

const isEpoch = (value: unknown): value is string => (
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)

function communityScopeEpoch(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const scope = value as Record<string, unknown>
  return Object.keys(scope).length === 2 && scope.version === PERSIST_VERSION && isEpoch(scope.epoch)
    ? scope.epoch : undefined
}

async function cacheTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return cacheStore(mode, async (store) => {
    const committed = promisifyRequest(store.transaction)
    try {
      const result = await operation(store)
      await committed
      return result
    } catch (error) {
      await committed.catch(() => undefined)
      throw error
    }
  })
}

async function readEligibility(store: IDBObjectStore, key: string, userId: string | null) {
  const [device, scope, account, channels] = await Promise.all([
    promisifyRequest<unknown>(store.get(DEVICE_EPOCH_KEY)),
    promisifyRequest<unknown>(store.get(scopeEpochKey(key))),
    promisifyRequest<unknown>(store.get(accountEpochKey(userId))),
    promisifyRequest<unknown>(store.get(channelFenceKey(userId))),
  ])
  return { device, scope, account, channels }
}

// Qualification starts when the account owner is created, before restore or
// any throttled persistence. Missing/corrupt eligibility never revives an old
// writer or trusts its payload; generation tombstones survive payload removal.
function qualifyPersister(key: string, userId: string | null): Promise<PersistEligibility> {
  return cacheTransaction("readwrite", async (store) => {
    await clearAccountRows(store, userId, true)
    const raw = await promisifyRequest<unknown>(store.get(key))
    const current = await readEligibility(store, key, userId)
    const device = isEpoch(current.device) ? current.device : crypto.randomUUID()
    const intact = isEpoch(current.account) && isChannelFences(current.channels)
    const account = intact ? current.account as string : crypto.randomUUID()
    const channels = intact ? current.channels as Map<string, ChannelDiskFence> : new Map<string, ChannelDiskFence>()
    const currentScope = communityScopeEpoch(current.scope)
    const compatiblePayload = raw === undefined || Boolean(decodeDiskSnapshot(raw))
    let scope = currentScope && compatiblePayload ? currentScope : crypto.randomUUID()
    if (!intact) {
      for (const domain of ["community", "application"] as const) {
        const payloadKey = blobKeyFor(userId, domain)
        const epoch = crypto.randomUUID()
        store.delete(payloadKey)
        store.put(epoch, scopeEpochKey(payloadKey))
        if (payloadKey === key) scope = epoch
      }
      store.put(account, accountEpochKey(userId))
      store.put(channels, channelFenceKey(userId))
    }
    if (!isEpoch(current.device) || !currentScope || !compatiblePayload) store.delete(key)
    if (!isEpoch(current.device)) store.put(device, DEVICE_EPOCH_KEY)
    store.put({ version: PERSIST_VERSION, epoch: scope }, scopeEpochKey(key))
    return { device, scope, account, channels }
  })
}

async function withEligiblePersister<T>(
  key: string,
  userId: string | null,
  eligibility: Promise<PersistEligibility>,
  mode: IDBTransactionMode,
  staleValue: T,
  operation: (store: IDBObjectStore, current: Map<string, ChannelDiskFence>, expected: Map<string, ChannelDiskFence>) => Promise<T>,
): Promise<T> {
  const expected = await eligibility
  return cacheTransaction(mode, async (store) => {
    const current = await readEligibility(store, key, userId)
    if (current.device !== expected.device || communityScopeEpoch(current.scope) !== expected.scope || current.account !== expected.account || !isChannelFences(current.channels)) return staleValue
    return operation(store, current.channels, expected.channels)
  })
}

/** Native TanStack persister, qualified against durable device/account epochs. */
export function createIdbPersister(userId: string | null): QualifiedPersister {
  const key = blobKeyFor(userId)
  const eligibility = qualifyPersister(key, userId)
  // An unavailable IDB must also fail restore through the provider's onError;
  // attach a handler immediately so qualification cannot reject unobserved.
  void eligibility.catch(() => undefined)
  const persister = createAsyncStoragePersister({
    storage: {
      getItem: () => observeRestoreRead(() => withEligiblePersister(key, userId, eligibility, "readwrite", null, async (store, current) => {
        const decoded = decodeDiskSnapshot(await promisifyRequest<unknown>(store.get(key)))
        if (!decoded) store.delete(key)
        return decoded ? JSON.stringify(scrubDehydratedClient(decoded.snapshot, userId, changedChannelFences(current, decoded.fences))) : null
      }), persister),
      setItem: (_k: string, value: string) => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store, current, expected) => {
          const snapshot = scrubDehydratedClient(JSON.parse(value) as PersistedClient, userId, changedChannelFences(current, expected))
          store.put(JSON.stringify({ ...snapshot, version: PERSIST_VERSION, channelFences: [...current] }), key)
        },
      ),
      // Expiry/buster removal removes only this payload. It does not retire
      // the owner, so its subsequent fresh network results can persist.
      removeItem: () => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store) => { store.delete(key) },
      ),
    },
    key: "alook-query-cache",
    serialize: (client) => JSON.stringify(scrubDehydratedClient(client, userId)),
    deserialize: (raw) => observeRestoreDecode(persister, () => scrubDehydratedClient(JSON.parse(raw) as PersistedClient, userId), PERSIST_BUSTER, PERSIST_MAX_AGE_MS),
  })
  return Object.assign(persister, {
    isCurrent: () => withEligiblePersister(key, userId, eligibility, "readonly", false, async () => true),
    retireChannels: (ids: Iterable<string>, deleted = false) => withEligiblePersister(key, userId, eligibility, "readwrite", undefined, (store, current) => retireChannelRows(store, key, userId, current, ids, deleted)),
    retireAccount: async () => {
      const retired = await withEligiblePersister(key, userId, eligibility, "readwrite", false, async (store) => { await clearAccountRows(store, userId); return true })
      if (retired) publishCacheInvalidation()
    },
  })
}

async function clearAccountRows(store: IDBObjectStore, userId: string | null, legacyOnly = false): Promise<void> {
  if (!legacyOnly) {
    store.put(crypto.randomUUID(), accountEpochKey(userId))
    store.put(new Map(), channelFenceKey(userId))
    for (const domain of ["community", "application"] as const) {
      const key = blobKeyFor(userId, domain)
      store.put(crypto.randomUUID(), scopeEpochKey(key))
      store.delete(key)
    }
  }
  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      const match = typeof cursor.key === "string" && /^(alook:qc:[^:]+):([^:]+):((?:application:)?client(?::epoch)?|account-epoch(?::channels)?)$/.exec(cursor.key)
      if (match && match[2] === (userId ?? "anon") && (!legacyOnly || match[1] !== IDB_PREFIX)) {
        if (match[3] === "account-epoch:channels") cursor.update(new Map())
        else if (match[3]?.endsWith("epoch")) cursor.update(crypto.randomUUID())
        else cursor.delete()
      }
      cursor.continue()
    }
  })
}

async function retireChannelRows(store: IDBObjectStore, key: string, userId: string | null, current: Map<string, ChannelDiskFence>, ids: Iterable<string>, deleted: boolean) {
  const scopes = [...ids]
  if (!scopes.length) return
  await clearAccountRows(store, userId, true)
  const fences = new Map(current)
  for (const id of scopes) fences.set(id, { epoch: crypto.randomUUID(), deleted: deleted || fences.get(id)?.deleted === true })
  store.put(fences, channelFenceKey(userId))
  const decoded = decodeDiskSnapshot(await promisifyRequest<unknown>(store.get(key)))
  if (decoded) {
    const snapshot = scrubDehydratedClient(decoded.snapshot, userId, changedChannelFences(fences, decoded.fences))
    store.put(JSON.stringify({ ...snapshot, version: PERSIST_VERSION, channelFences: [...fences] }), key)
  } else store.delete(key)
}

export async function clearPersistedCache(userId: string | null): Promise<void> {
  await cacheTransaction("readwrite", (store) => clearAccountRows(store, userId))
  publishCacheInvalidation()
}

export async function getPersistedCacheSizeBytes(signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new DOMException("Cancelled cache size read", "AbortError")
  const bytes = await cacheTransaction("readonly", (store) => new Promise<number>((resolve, reject) => {
    let total = 0
    const encoder = new TextEncoder()
    const request = store.openCursor()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(total); return }
      if (isPersistedCacheBlobKey(cursor.key) && typeof cursor.value === "string") {
        total += encoder.encode(cursor.value).byteLength
      }
      cursor.continue()
    }
  }))
  if (signal?.aborted) throw new DOMException("Cancelled cache size read", "AbortError")
  const legacyBytes = await getLegacyChatCacheSizeBytes(signal)
  const publicBytes = await getPublicWorkerCacheSizeBytes(signal)
  if (signal?.aborted) throw new DOMException("Cancelled cache size read", "AbortError")
  return bytes + legacyBytes + publicBytes
}

/** Clear this device, including qualified writers with no payload yet. */
export async function clearAllPersistedCaches(): Promise<void> {
  await cacheTransaction("readwrite", (store) => new Promise<void>((resolve, reject) => {
    store.put(crypto.randomUUID(), DEVICE_EPOCH_KEY)
    const request = store.openCursor()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      if (isPersistedCacheBlobKey(cursor.key)) cursor.delete()
      cursor.continue()
    }
  }))
  try {
    const results = await Promise.allSettled([clearLegacyChatCaches(), clearPublicWorkerCaches()])
    for (const result of results) if (result.status === "rejected") throw result.reason
  } finally { publishCacheInvalidation() }
}
