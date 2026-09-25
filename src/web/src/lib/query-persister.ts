import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { del, get, set } from "idb-keyval"
import type { MessagesPage } from "@/lib/community/models/message"
import { isCommunityServerDetailQueryKey } from "@/lib/query-keys"
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
 * Only these query-key kinds are persisted. Everything else refetches on mount.
 *
 * Note: read-state snapshots were previously persisted but were removed to
 * kill a self-inflicted staleness bug — a hydrated snapshot with a stale
 * `lastReadMessageId` would anchor the "New" divider to a row that had long
 * since scrolled off. The snapshot hooks now refetch on every mount, so
 * persisting them is a strict downside (bytes on disk + risk of drift).
 */
const PERSISTED_KINDS = new Set<string>([
  "servers",
  "folders",
  "dms",
  "serverDetail",
  "communityDbCollection",
])

export const MAX_PERSISTED_SERVER_DETAILS = 5
export const MAX_PERSISTED_MESSAGE_SCOPES = 20
export const MAX_PERSISTED_MESSAGES_PER_SCOPE = 50

// Query keys start with `["community", <kind>, ...]` — the first segment is
// the namespace, the second segment is a discriminator (`"channel"`, `"dm"`,
// `"servers"`, …), and for message queries the third+ segments carry the id
// and the literal `"messages"` / `"read-state-snapshot"` tail. See
// `src/web/src/lib/query-keys.ts`.
function keyKindFor(queryKey: readonly unknown[]): string | null {
  if (!Array.isArray(queryKey) || queryKey.length < 2) return null
  if (queryKey[0] !== "community") return null
  const second = queryKey[1]
  if (
    second === "db"
    && queryKey.length === 4
    && typeof queryKey[2] === "string"
    && typeof queryKey[3] === "string"
  ) {
    return "communityDbCollection"
  }
  if (second === "servers") {
    if (queryKey.length === 2) return "servers"
    if (isCommunityServerDetailQueryKey(queryKey)) return "serverDetail"
    return null
  }
  if (second === "folders" && queryKey.length === 2) return "folders"
  if (second === "dms" && queryKey.length === 2) return "dms"
  // Message queries: ["community", "channel", <id>, "messages"] or
  // ["community", "dm", <id>, "messages"].
  if (second === "channel" || second === "dm") {
    const tail = queryKey[queryKey.length - 1]
    if (tail === "messages") {
      return second === "channel" ? "channelMessages" : "dmMessages"
    }
    if (tail === "read-state-snapshot") {
      return second === "channel"
        ? "channelReadStateSnapshot"
        : "dmReadStateSnapshot"
    }
  }
  return null
}

export function shouldPersistQueryKey(queryKey: readonly unknown[]): boolean {
  const kind = keyKindFor(queryKey)
  return kind !== null && PERSISTED_KINDS.has(kind)
}

/**
 * Trust rule for the first page of a persisted message stream.
 *
 * Persistence is only safe when the cached window represents "we know we have
 * the newest tail." A since-mode or older-only envelope has no `hasMore` flag
 * on `pages[0]`, so the tail-of-history read (`oldestPage.hasMoreOlder ??
 * oldestPage.hasMore ?? false`) collapses to `false` on the next mount and
 * the UI silently loses history until a manual cache clear.
 *
 * Trusted shapes:
 * - Legacy newest-mode: `hasMore !== undefined && hasMoreOlder === undefined
 *   && hasMoreNewer === undefined`. This is the pre-anchor cache shape.
 * - Anchor-mode with the tail attached: `hasMoreNewer === false`. Guarantees
 *   the client has loaded everything up to the current latestSeq, so the
 *   window on disk is a real newest-side window we can safely hand to the
 *   next mount.
 */
export function isTrustedMessagesPageZero(page: MessagesPage | undefined): boolean {
  if (!page) return false
  const isLegacyNewest =
    page.hasMore !== undefined &&
    page.hasMoreOlder === undefined &&
    page.hasMoreNewer === undefined
  if (isLegacyNewest) return true
  // Defense-in-depth (paired with buildSinceResponse now emitting an older-side
  // signal): a page is only a trustworthy standalone tail if the NEXT mount can
  // read back through it. `hasMoreNewer === false` alone isn't enough — a since
  // page carried that yet lacked any older signal, so rehydrating it as the
  // sole page stranded scroll-up (the bug this guards). Require an older-side
  // signal (`hasMoreOlder`/`hasMore` present) so a page that can't self-report
  // its older edge never survives to disk, whatever produced it.
  if (
    page.hasMoreNewer === false &&
    (page.hasMoreOlder !== undefined || page.hasMore !== undefined)
  ) {
    return true
  }
  return false
}

/**
 * Query-level filter used by both `shouldDehydrateQuery` (write side) and
 * `scrubDehydratedClient` (read side of the same walk). Non-message queries
 * fall through to `shouldPersistQueryKey`; message queries additionally check
 * `pages[0]` shape so a stale/mid-history cache never survives to the next
 * mount.
 */
export function shouldPersistQuery(
  queryKey: readonly unknown[],
  data: unknown,
): boolean {
  if (!shouldPersistQueryKey(queryKey)) return false
  const kind = keyKindFor(queryKey)
  if (kind !== "channelMessages" && kind !== "dmMessages") return true
  const pages = (data as { pages?: MessagesPage[] } | undefined)?.pages
  if (!Array.isArray(pages) || pages.length === 0) return false
  return isTrustedMessagesPageZero(pages[0])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === "string"
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function optional(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return value === undefined || predicate(value)
}

function nullableString(value: unknown): boolean {
  return value === null || isString(value)
}

function isArrayOf(
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(predicate)
}

function isPersistedServerUnreadSource(value: unknown): boolean {
  return isRecord(value)
    && isString(value.channelId)
    && isFiniteNumber(value.lastUnreadSeq)
}

function isPersistedServerMentionSource(value: unknown): boolean {
  return isRecord(value)
    && isString(value.channelId)
    && isFiniteNumber(value.count)
    && isFiniteNumber(value.lastSeq)
}

function isPersistedServer(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.initial)
    && typeof value.active === "boolean"
    && typeof value.unread === "boolean"
    && isFiniteNumber(value.mentions)
    && optional(value.discriminator, isString)
    && optional(value.description, isString)
    && optional(value.ownerId, isString)
    && optional(value.icon, nullableString)
    && optional(value.official, (candidate) => typeof candidate === "boolean")
    && optional(value.isOwner, (candidate) => typeof candidate === "boolean")
    && optional(value.unreadSources, (candidate) => (
      isArrayOf(candidate, isPersistedServerUnreadSource)
    ))
    && optional(value.mentionSources, (candidate) => (
      isArrayOf(candidate, isPersistedServerMentionSource)
    ))
}

function isPersistedFolderServer(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.initial)
    && optional(value.icon, nullableString)
}

function isPersistedFolder(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isFiniteNumber(value.position)
    && isArrayOf(value.servers, isPersistedFolderServer)
}

function isPersistedDm(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.userId)
    && isString(value.name)
    && isString(value.discriminator)
    && isString(value.avatar)
    && isFiniteNumber(value.avatarVersion)
    && (value.status === "online" || value.status === "offline")
    && isString(value.preview)
    && optional(value.unread, (candidate) => typeof candidate === "boolean")
    && optional(value.lastUnreadSeq, isFiniteNumber)
}

function isPersistedChannel(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && typeof value.active === "boolean"
    && typeof value.unread === "boolean"
    && optional(value.muted, (candidate) => typeof candidate === "boolean")
    && optional(value.type, (candidate) => candidate === "text" || candidate === "forum")
    && optional(value.tags, (candidate) => isArrayOf(candidate, isString))
    && optional(value.creatorId, nullableString)
    && optional(value.pending, (candidate) => typeof candidate === "boolean")
}

function isPersistedCategory(value: unknown): boolean {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isArrayOf(value.channels, isPersistedChannel)
    && optional(value.private, (candidate) => (
      typeof candidate === "boolean" || isFiniteNumber(candidate)
    ))
    && optional(value.creatorId, nullableString)
    && optional(value.pending, (candidate) => typeof candidate === "boolean")
}

function isPersistedForumUnreadStateEntry(value: unknown): boolean {
  return isRecord(value)
    && typeof value.baseUnread === "boolean"
    && isArrayOf(value.childIds, isString)
}

function isPersistedForumUnreadState(value: unknown): boolean {
  return isRecord(value)
    && Object.values(value).every(isPersistedForumUnreadStateEntry)
}

function isPersistedDetailUnreadSource(value: unknown): boolean {
  return isRecord(value)
    && isString(value.channelId)
    && isFiniteNumber(value.lastUnreadSeq)
    && (value.lastAttentionSeq === null || isFiniteNumber(value.lastAttentionSeq))
}

function isPersistedServerDetail(value: unknown, serverId: unknown): boolean {
  return isRecord(value)
    && value.id === serverId
    && isString(value.name)
    && isString(value.discriminator)
    && isString(value.description)
    && nullableString(value.icon)
    && isString(value.ownerId)
    && isArrayOf(value.categories, isPersistedCategory)
    && optional(value.official, (candidate) => typeof candidate === "boolean")
    && optional(value.forumUnreadState, isPersistedForumUnreadState)
    && optional(value.unreadSources, (candidate) => (
      isArrayOf(candidate, isPersistedDetailUnreadSource)
    ))
}

function isPersistedReadClosureData(
  kind: "servers" | "folders" | "dms" | "serverDetail",
  data: unknown,
  queryKey: readonly unknown[],
): boolean {
  if (!isRecord(data)) return false
  if (kind === "servers") return isArrayOf(data.servers, isPersistedServer)
  if (kind === "folders") return isArrayOf(data.folders, isPersistedFolder)
  if (kind === "dms") return isArrayOf(data.conversations, isPersistedDm)
  return isPersistedServerDetail(data, queryKey[2])
}

/**
 * Retain the bounded canonical read closure without mutating the live cache.
 */
function scrubDehydratedClient(
  client: PersistedClient,
  userId: string | null,
): PersistedClient {
  const queries: typeof client.clientState.queries = []
  const serverDetails = client.clientState.queries
    .filter((q) => keyKindFor(q.queryKey) === "serverDetail")
    .filter((q) => isPersistedReadClosureData("serverDetail", q.state.data, q.queryKey))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .slice(0, MAX_PERSISTED_SERVER_DETAILS)
  const retainedServerIds = new Set(
    serverDetails.flatMap((query) => (
      typeof query.queryKey[2] === "string" ? [query.queryKey[2]] : []
    )),
  )
  const canonical = new Map<CommunityCollectionName, unknown[]>()
  for (const q of client.clientState.queries) {
    const kind = keyKindFor(q.queryKey)
    if (kind === "communityDbCollection") {
      if (!userId || q.queryKey[2] !== userId) continue
      const collectionName = q.queryKey[3] as CommunityCollectionName
      const schema = communityCollectionSchemas[collectionName]
      if (!schema) continue
      const parsed = schema.array().safeParse(q.state.data)
      if (!parsed.success) continue
      canonical.set(collectionName, parsed.data)
      continue
    }
    if (
      kind === "servers"
      || kind === "folders"
      || kind === "dms"
      || kind === "serverDetail"
    ) {
      if (!isPersistedReadClosureData(kind, q.state.data, q.queryKey)) continue
      if (kind !== "serverDetail") queries.push(q)
      continue
    }
  }

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
    row.relation === "access"
      && durableChannelIds.has(row.channelId)
      && (row.userId === userId || retainedDmIds.has(row.channelId))
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
    if (keyKindFor(q.queryKey) !== "communityDbCollection") continue
    if (!userId || q.queryKey[2] !== userId) continue
    const collectionName = q.queryKey[3] as CommunityCollectionName
    const data = windowed[collectionName]
    if (data) queries.push({ ...q, state: { ...q.state, data } })
  }
  queries.push(...serverDetails)
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
