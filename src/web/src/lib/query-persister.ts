import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import {
  communityCollectionSchemas,
  type CommunityCollectionName,
} from "@/lib/community-db/schema"

/**
 * IDB namespace root. Bumping the tail segment (`v1` → `v2`) invalidates every
 * cached payload — use it as the escape hatch when the persisted query shape
 * changes in a way the runtime can't reconcile against fresh server data.
 */
const IDB_PREFIX = "alook:qc:v2"

/**
 * Buster tag paired with `PersistedClient`. TanStack throws away restored
 * state whose buster doesn't match — a cheap secondary lever when just the
 * shape of a specific query needs to be reset without touching the IDB
 * namespace.
 */
export const PERSIST_BUSTER = "v2"

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
  const retainedChannels = channels.filter((row) => (
    row.serverId === null || row.serverId === undefined || retainedServerIds.has(row.serverId)
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
  const retainedMessages = [...messagesByScope.values()]
    .map((rows) => rows.slice().sort(compareMessagesNewest))
    .sort((a, b) => compareMessagesNewest(a[0]!, b[0]!))
    .slice(0, MAX_PERSISTED_MESSAGE_SCOPES)
    .flatMap((rows) => rows.slice(0, MAX_PERSISTED_MESSAGES_PER_SCOPE))
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

  const windowed: Partial<Record<CommunityCollectionName, unknown[]>> = {
    ...Object.fromEntries(canonical),
    categories: ((canonical.get("categories") ?? []) as Array<{ serverId: string }>).filter(
      (row) => retainedServerIds.has(row.serverId),
    ),
    channels: retainedChannels,
    serverMemberships: retainedServerMemberships,
    channelMemberships: retainedChannelMemberships,
    messages: retainedMessages,
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
function blobKeyFor(userId: string | null): string {
  return `${namespaceFor(userId)}:client`
}

type PersistCoordination = {
  generations: Map<string, number>
  operations: Map<string, Promise<void>>
}

// Keep the fence shared across client chunks and dev hot-reloads. QueryProvider
// can retain a persister created by an older module instance while the logout
// surface imports a freshly evaluated one; module-local maps would let those
// two instances race even though they operate on the same IndexedDB key.
const persistGlobal = globalThis as typeof globalThis & {
  __alookQueryPersistCoordinationV1?: PersistCoordination
}
const persistCoordination = persistGlobal.__alookQueryPersistCoordinationV1 ?? {
  generations: new Map<string, number>(),
  operations: new Map<string, Promise<void>>(),
}
persistGlobal.__alookQueryPersistCoordinationV1 = persistCoordination
const persistGenerations = persistCoordination.generations
const persistOperations = persistCoordination.operations

/**
 * Serialize reads, writes, and clears for one account namespace.
 *
 * The generation check rejects work that starts after a logout, but it cannot
 * cancel an IndexedDB write that already passed the check. Keeping the clear
 * behind that in-flight write makes the delete the final operation from the
 * retired generation, while a newly authenticated persister queues after it.
 */
function runPersistOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = persistOperations.get(key) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(() => undefined, () => undefined)
  persistOperations.set(key, tail)
  void tail.then(() => {
    if (persistOperations.get(key) === tail) persistOperations.delete(key)
  })
  return result
}

/**
 * Create an async-storage persister scoped to a specific user id.
 *
 * Every read/write is namespaced by `userId` so signing in as a different
 * account never surfaces the previous user's cached rows. `serialize` retains
 * only the bounded canonical read closure before it reaches disk.
 */
export function createIdbPersister(userId: string | null): Persister {
  const key = blobKeyFor(userId)
  const generation = persistGenerations.get(key) ?? 0
  return createAsyncStoragePersister({
    storage: {
      getItem: async (_k: string) => {
        return runPersistOperation(key, async () => {
          const value = await get<string>(key)
          return value ?? null
        })
      },
      setItem: async (_k: string, value: string) => {
        await runPersistOperation(key, async () => {
          if ((persistGenerations.get(key) ?? 0) !== generation) return
          await set(key, value)
        })
      },
      removeItem: async (_k: string) => {
        await runPersistOperation(key, async () => {
          if ((persistGenerations.get(key) ?? 0) !== generation) return
          await del(key)
        })
      },
    },
    // Passed to storage under the covers, but our storage adapter ignores the
    // key argument (we own the namespace). Leaving a stable literal keeps the
    // persister's internal throttle bookkeeping predictable.
    key: "alook-query-cache",
    serialize: (client) => JSON.stringify(scrubDehydratedClient(client, userId)),
    deserialize: (raw) => scrubDehydratedClient(
      JSON.parse(raw) as PersistedClient,
      userId,
    ),
  })
}

/**
 * Delete the persisted blob for a given user id. Wire into the sign-out flow
 * so a shared machine doesn't leak the previous session's cached message
 * history to the next tab.
 */
export async function clearPersistedCache(userId: string | null): Promise<void> {
  const key = blobKeyFor(userId)
  persistGenerations.set(key, (persistGenerations.get(key) ?? 0) + 1)
  await runPersistOperation(key, async () => del(key))
}
