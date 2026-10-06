import { clearLegacyChatCaches, getLegacyChatCacheSizeBytes } from "@/lib/legacy-chat-persistence"
import { observeRestoreRead, observeRestoreDecode } from "@/lib/observability/restore"
import { createStore as createNativeStore } from "@tanstack/store"
import { scrubApplicationClient } from "@/lib/workspace-chat-persistence"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { createStore, promisifyRequest } from "idb-keyval"
import {
  communityCollectionSchemas,
  type CommunityCollectionName,
} from "@/lib/community-db/schema"

/**
 * IDB namespace root. Bumping the tail segment (`v1` → `v2`) invalidates every
 * cached payload — use it as the escape hatch when the persisted query shape
 * changes in a way the runtime can't reconcile against fresh server data.
 */
// v3 does not import v2: older tabs write unqualified bare payloads. Their
// late writes must never become a new owner's restore input after clear.
const IDB_PREFIX = "alook:qc:v3"

/**
 * Buster tag paired with `PersistedClient`. TanStack throws away restored
 * state whose buster doesn't match — a cheap secondary lever when just the
 * shape of a specific query needs to be reset without touching the IDB
 * namespace.
 */
export const PERSIST_BUSTER = "v3"

/** Persister max-age; queries older than this are discarded on restore. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Only canonical TanStack DB collection snapshots are persisted. Transport
 * queries are deliberately session-only: restoring both their raw payloads
 * and the canonical collections creates two clocks for the same server facts.
 *
 * Note: read-state snapshots were previously persisted but were removed to
 * kill a self-inflicted staleness bug — a hydrated snapshot with a stale
 * `lastReadMessageId` would anchor the "New" divider to a row that had long
 * since scrolled off. The snapshot hooks now refetch on every mount, so
 * persisting them is a strict downside (bytes on disk + risk of drift).
 */
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
  return isCommunityDbCollectionKey(queryKey)
}

export function shouldPersistQuery(
  queryKey: readonly unknown[],
  _data: unknown,
): boolean {
  return shouldPersistQueryKey(queryKey)
}

/**
 * Retain the bounded canonical read closure without mutating the live cache.
 */
function scrubDehydratedClient(
  client: PersistedClient,
  userId: string | null,
): PersistedClient {
  const queries: typeof client.clientState.queries = []
  const canonical = new Map<CommunityCollectionName, unknown[]>()
  for (const q of client.clientState.queries) {
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

  const retainedServerIds = new Set(
    ((canonical.get("servers") ?? []) as Array<{ id: string }>).map((row) => row.id),
  )

  const channels = (canonical.get("channels") ?? []) as Array<{
    id: string
    serverId?: string | null
    type: "text" | "forum" | "thread" | "dm"
  }>
  const attentionScopes = (canonical.get("attentionScopes") ?? []) as Array<{
    scopeId: string
    channelId: string
  }>
  const retainedAttentionItems = ((canonical.get("attentionItems") ?? []) as Array<{
    id: string
    kind: "mention" | "reply" | "friend_request" | "pending"
    messageId?: string | null
    actorUserId: string
    createdAt: string
  }>).slice()
  const retainedMessageAttention = retainedAttentionItems
    .filter((item) => item.kind !== "friend_request")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, MAX_PERSISTED_ATTENTION_ITEMS)
  const retainedFriendAttention = retainedAttentionItems
    .filter((item) => item.kind === "friend_request")
  retainedAttentionItems.splice(
    0,
    retainedAttentionItems.length,
    ...retainedMessageAttention,
    ...retainedFriendAttention,
  )
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
  const allMessages = (canonical.get("messages") ?? []) as Array<{
    id: string
    channelId: string
    seq?: number
    createdAt?: string
    authorId?: string
    replyTo?: { authorId?: string }
    thread?: { participants?: Array<{ id: string }> }
  }>
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
  const serverMemberships = (canonical.get("serverMemberships") ?? []) as Array<{
    serverId: string
    userId: string
    viewer: boolean
  }>
  const retainedServerMemberships = serverMemberships.filter((row) => row.viewer)
  const channelMemberships = (canonical.get("channelMemberships") ?? []) as Array<{
    channelId: string
    userId: string
    relation: "access" | "notify"
  }>
  const retainedChannelMemberships = channelMemberships.filter((row) => (
    durableChannelIds.has(row.channelId)
      && (
        row.userId === userId
        || row.relation === "access" && retainedDmIds.has(row.channelId)
      )
  ))
  const referencedProfileIds = new Set<string>(userId ? [userId] : [])
  for (const server of (canonical.get("servers") ?? []) as Array<{ ownerId: string }>) {
    if (server.ownerId) referencedProfileIds.add(server.ownerId)
  }
  for (const membership of retainedServerMemberships) referencedProfileIds.add(membership.userId)
  for (const membership of retainedChannelMemberships) referencedProfileIds.add(membership.userId)
  for (const message of retainedMessages) {
    if (message.authorId) referencedProfileIds.add(message.authorId)
    if (message.replyTo?.authorId) referencedProfileIds.add(message.replyTo.authorId)
    for (const participant of message.thread?.participants ?? []) {
      referencedProfileIds.add(participant.id)
    }
    for (const profile of [
      (message as { approval?: { otherProfile?: { id?: string } } }).approval?.otherProfile,
      (message as { approval?: { botProfile?: { id?: string } } }).approval?.botProfile,
      (message as { approval?: { waitingOnProfile?: { id?: string } } }).approval?.waitingOnProfile,
    ]) {
      if (profile?.id) referencedProfileIds.add(profile.id)
    }
  }
  for (const item of retainedAttentionItems) referencedProfileIds.add(item.actorUserId)

  const windowed: Partial<Record<CommunityCollectionName, unknown[]>> = {
    ...Object.fromEntries(canonical),
    categories: ((canonical.get("categories") ?? []) as Array<{ serverId: string }>).filter(
      (row) => retainedServerIds.has(row.serverId),
    ),
    channels: retainedChannels,
    serverMemberships: retainedServerMemberships,
    channelMemberships: retainedChannelMemberships,
    messages: retainedMessages,
    attentionScopes,
    attentionItems: retainedAttentionItems,
    profiles: ((canonical.get("profiles") ?? []) as Array<{ userId: string }>).filter(
      (row) => referencedProfileIds.has(row.userId),
    ),
  }
  for (const q of client.clientState.queries) {
    if (!isCommunityDbCollectionKey(q.queryKey)) continue
    if (!userId || q.queryKey[2] !== userId) continue
    const collectionName = q.queryKey[3] as CommunityCollectionName
    const data = windowed[collectionName]
    if (data) queries.push({ ...q, state: { ...q.state, data } })
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
export type PersistDomain = "community" | "application"
export const CACHE_INVALIDATION_STORAGE_KEY = "alook:qc:invalidation"
export const cacheInvalidation = createNativeStore(0)
function publishCacheInvalidation() {
  cacheInvalidation.setState((version) => version + 1)
  try { if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_INVALIDATION_STORAGE_KEY, crypto.randomUUID()) } catch {}
}
export type QualifiedPersister = Persister & { isCurrent: () => Promise<boolean>; retireAccount: () => Promise<void> }
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
type PersistEligibility = { device: string; scope: string; account: string }
const isEpoch = (value: unknown): value is string => (
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
)

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
  const [device, scope, account] = await Promise.all([
    promisifyRequest<unknown>(store.get(DEVICE_EPOCH_KEY)),
    promisifyRequest<unknown>(store.get(scopeEpochKey(key))),
    promisifyRequest<unknown>(store.get(accountEpochKey(userId))),
  ])
  return { device, scope, account }
}

// Qualification starts when the account owner is created, before restore or
// any throttled persistence. Missing/corrupt eligibility never revives an old
// writer or trusts its payload; generation tombstones survive payload removal.
function qualifyPersister(key: string, userId: string | null): Promise<PersistEligibility> {
  return cacheTransaction("readwrite", async (store) => {
    const current = await readEligibility(store, key, userId)
    const device = isEpoch(current.device) ? current.device : crypto.randomUUID()
    const account = isEpoch(current.account) ? current.account : crypto.randomUUID()
    let scope = isEpoch(current.scope) ? current.scope : crypto.randomUUID()
    if (!isEpoch(current.account)) {
      for (const domain of ["community", "application"] as const) {
        const payloadKey = blobKeyFor(userId, domain)
        const epoch = crypto.randomUUID()
        store.delete(payloadKey)
        store.put(epoch, scopeEpochKey(payloadKey))
        if (payloadKey === key) scope = epoch
      }
      store.put(account, accountEpochKey(userId))
    }
    if (!isEpoch(current.device) || !isEpoch(current.scope)) store.delete(key)
    if (!isEpoch(current.device)) store.put(device, DEVICE_EPOCH_KEY)
    store.put(scope, scopeEpochKey(key))
    return { device, scope, account }
  })
}

async function withEligiblePersister<T>(
  key: string,
  userId: string | null,
  eligibility: Promise<PersistEligibility>,
  mode: IDBTransactionMode,
  staleValue: T,
  operation: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const expected = await eligibility
  return cacheTransaction(mode, async (store) => {
    const current = await readEligibility(store, key, userId)
    if (current.device !== expected.device || current.scope !== expected.scope || current.account !== expected.account) return staleValue
    return operation(store)
  })
}

/** Native TanStack persister, qualified against durable device/account epochs. */
export function createIdbPersister(userId: string | null, domain: PersistDomain = "community"): QualifiedPersister {
  const key = blobKeyFor(userId, domain)
  const eligibility = qualifyPersister(key, userId)
  // An unavailable IDB must also fail restore through the provider's onError;
  // attach a handler immediately so qualification cannot reject unobserved.
  void eligibility.catch(() => undefined)
  const persister = createAsyncStoragePersister({
    storage: {
      getItem: () => observeRestoreRead(() => withEligiblePersister(key, userId, eligibility, "readonly", null, async (store) => {
        const value = await promisifyRequest<unknown>(store.get(key))
        return typeof value === "string" ? value : null
      }), persister),
      setItem: (_k: string, value: string) => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store) => { store.put(value, key) },
      ),
      // Expiry/buster removal removes only this payload. It does not retire
      // the owner, so its subsequent fresh network results can persist.
      removeItem: () => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store) => { store.delete(key) },
      ),
    },
    key: "alook-query-cache",
    serialize: (client) => JSON.stringify(domain === "application" ? scrubApplicationClient(client, userId) : scrubDehydratedClient(client, userId)),
    deserialize: (raw) => observeRestoreDecode(persister, () => domain === "application" ? scrubApplicationClient(JSON.parse(raw) as PersistedClient, userId) : scrubDehydratedClient(JSON.parse(raw) as PersistedClient, userId), domain === "application" ? PERSIST_BUSTER + "-application" : PERSIST_BUSTER, PERSIST_MAX_AGE_MS),
  })
  return Object.assign(persister, {
    isCurrent: () => withEligiblePersister(key, userId, eligibility, "readonly", false, async () => true),
    retireAccount: async () => {
      const retired = await withEligiblePersister(key, userId, eligibility, "readwrite", false, async (store) => { await clearAccountRows(store, userId); return true })
      if (retired) publishCacheInvalidation()
    },
  })
}

async function clearAccountRows(store: IDBObjectStore, userId: string | null): Promise<void> {
  store.put(crypto.randomUUID(), accountEpochKey(userId))
  for (const domain of ["community", "application"] as const) {
    const key = blobKeyFor(userId, domain)
    store.put(crypto.randomUUID(), scopeEpochKey(key))
    store.delete(key)
  }
  await new Promise<void>((resolve, reject) => {
    const request = store.openCursor()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      if (isPersistedCacheBlobKey(cursor.key) && cursor.key.split(":")[3] === (userId ?? "anon")) cursor.delete()
      cursor.continue()
    }
  })
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
  if (signal?.aborted) throw new DOMException("Cancelled cache size read", "AbortError")
  return bytes + legacyBytes
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
  try { await clearLegacyChatCaches() } finally { publishCacheInvalidation() }
}
