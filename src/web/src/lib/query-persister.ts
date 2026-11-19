import { messageWindowIdentity, readPersistedMessageWindow, persistedMessageWindowComplete, boundPersistedMessageWindow, messageWindowMessageIds, messageWindowDependencies, type PersistedMessageWindow } from "@/lib/community/message-window-persistence"
import { isServerDirectoryWindowKey, readServerDirectoryWindow, serverDirectoryWindowComplete, type ServerDirectoryWindow } from "@/lib/community/server-directory-window"
import { CommunitySelfProfileReadSchema } from "@alook/shared"
import { forumSidebarWindowComplete, isForumSidebarWindowKey, readForumSidebarWindowResult } from "@/lib/community/forum-sidebar-window"
import { clearLegacyChatCaches, getLegacyChatCacheSizeBytes } from "@/lib/legacy-chat-persistence"
import { clearPublicWorkerCaches, getPublicWorkerCacheSizeBytes } from "@/lib/service-worker/public-cache-storage"
import { observeRestoreRead, observeRestoreDecode } from "@/lib/observability/restore"
import { createStore as createNativeStore } from "@tanstack/store"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import type {
  PersistedClient,
  Persister,
} from "@tanstack/react-query-persist-client"
import { get, promisifyRequest } from "idb-keyval"
import { isCommunityListResourceKey, persistentCommunityListResource } from "@/lib/community/list-persistence"
import { isPageListQueryKey, pageListMessageIds, pageListWindowComplete, readPageListWindow } from "@/lib/community/page-list-persistence"
import { directoryWindowChannelMembershipIds, directoryWindowComplete, directoryWindowRetiredKeys, directoryWindowScopeKeys, directoryWindowServerMembershipIds, isDirectoryWindowKey, MAX_PERSISTED_DIRECTORY_WINDOWS, projectDirectoryWindow, readDirectoryWindow, type DirectoryWindow } from "@/lib/community/directory-window-persistence"
import { botDirectoryWindowComplete, botDirectoryWindowRetiredKeys, botDirectoryWindowScopeKeys, isBotDirectoryWindowKey, readBotDirectoryWindow, type BotDirectoryWindow } from "@/lib/community/bot-directory-window"
import { AUXILIARY_READ_EPOCH_KEY, auxiliaryWindowScopeKey, type AuxiliaryReadReference, type AuxiliaryWindowScope } from "@/lib/community/auxiliary-window-contract"
import { displayWindowComplete, displayWindowIdentity, displayWindowRetiredKeys, displayWindowScopeKeys, readDisplayWindow, type DisplayDomain, type DisplayWindow } from "@/lib/community/display-window-persistence"
import {
  communityCollectionSchemas,
  type CommunityCollectionName,
  type CommunityCollectionRows,
} from "@/lib/community-db/schema"

import {
  PERSIST_VERSION, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, PERSIST_ACCOUNT_PREFIX,
  DEVICE_EPOCH_KEY, LAST_ACCOUNT_KEY, accountEpochKey, scopeEpochKey, blobKeyFor,
  accountIdentityRecord, readPersistedAccountClaim, isEpoch, communityScopeEpoch,
  type AccountIdentityRecord, type PersistedAccountIdentity,
} from "./persisted-account-identity"
import { cacheStore, cacheTransaction } from "./query-cache-store"
export { PERSIST_VERSION, PERSIST_BUSTER, PERSIST_CACHE_PREFIX, PERSIST_ACCOUNT_PREFIX, type PersistedAccountIdentity } from "./persisted-account-identity"
const IDB_PREFIX = PERSIST_CACHE_PREFIX

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
  return displayWindowIdentity(queryKey)?.domain === "community" || isCommunityDbCollectionKey(queryKey) || isCommunityListResourceKey(queryKey) || isPageListQueryKey(queryKey) || isDirectoryWindowKey(queryKey) || isBotDirectoryWindowKey(queryKey) || isForumSidebarWindowKey(queryKey) || isServerDirectoryWindowKey(queryKey) || messageWindowIdentity(queryKey) !== undefined
}

export function shouldPersistQuery(
  queryKey: readonly unknown[],
  data: unknown,
): boolean {
  return isCommunityDbCollectionKey(queryKey) || readPersistedMessageWindow(queryKey, data, 0) !== undefined || persistentCommunityListResource(queryKey, data) !== undefined
    || readPageListWindow(queryKey, data) !== undefined
    || readDirectoryWindow(queryKey, data) !== undefined
    || readBotDirectoryWindow(queryKey, data) !== undefined
    || readDisplayWindow(queryKey, data)?.domain === "community"
    || isServerDirectoryWindowKey(queryKey) && readServerDirectoryWindow(data)?.serverId === queryKey[2]
    || isForumSidebarWindowKey(queryKey) && readForumSidebarWindowResult(data)?.window.serverId === queryKey[2]
}

export function shouldDehydrateCommunityQuery(query: { queryKey: readonly unknown[]; state: { status: string; data: unknown } }) {
  return (query.state.status === "success" || displayWindowIdentity(query.queryKey)?.domain === "community" || isForumSidebarWindowKey(query.queryKey) || isPageListQueryKey(query.queryKey) || isDirectoryWindowKey(query.queryKey) || isBotDirectoryWindowKey(query.queryKey) || messageWindowIdentity(query.queryKey) !== undefined)
    && shouldPersistQuery(query.queryKey, query.state.data)
}

export function shouldDehydrateApplicationQuery(query: { queryKey: readonly unknown[]; state: { data: unknown } }) {
  return readDisplayWindow(query.queryKey, query.state.data)?.domain === "application"
}

type PersistedQuery = PersistedClient["clientState"]["queries"][number]
function displayQuery(query: PersistedQuery, window: DisplayWindow): PersistedQuery {
  return { ...query, state: { ...query.state, data: window.data, status: "success", error: null, errorUpdatedAt: 0,
    errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } }
}

function currentDisplayTime(query: PersistedQuery) {
  return Number.isFinite(query.state.dataUpdatedAt) && query.state.dataUpdatedAt > 0 && Date.now() - query.state.dataUpdatedAt <= PERSIST_MAX_AGE_MS
}

function scrubApplicationClient(client: PersistedClient, userId: string | null) {
  const queries = client.clientState.queries.slice().sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .flatMap(query => {
      const window = readDisplayWindow(query.queryKey, query.state.data)
      return window && currentDisplayTime(query) && displayWindowComplete(window, {}, userId, "application") ? [displayQuery(query, window)] : []
    }).slice(0, MAX_PERSISTED_DIRECTORY_WINDOWS)
  return { ...client, clientState: { queries, mutations: [] } }
}

export type CommunityRestoredCollections = Partial<{
  [N in CommunityCollectionName]: { rows: CommunityCollectionRows[N][]; updatedAt: number }
}> & { messageWindows?: PersistedMessageWindow[] }

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
    Object.assign(collections, { [name]: { rows: parsed.data, updatedAt: query.state.dataUpdatedAt } })
  }
  const rows = { channels: collections.channels?.rows, servers: collections.servers?.rows,
    channelMemberships: collections.channelMemberships?.rows, messages: collections.messages?.rows, profiles: collections.profiles?.rows }
  const windows = snapshot.clientState.queries.flatMap(query => {
    if (query.state.status !== "success" && !query.state.dataUpdatedAt) return []
    const window = readPersistedMessageWindow(query.queryKey, query.state.data, query.state.dataUpdatedAt)
    return window && persistedMessageWindowComplete(window, rows, userId) ? [window] : []
  })
  if (windows.length) collections.messageWindows = windows
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
        queries: restored.clientState.queries.filter((query) => !isCommunityDbCollectionKey(query.queryKey) && !messageWindowIdentity(query.queryKey)),
      } }
    },
    removeClient: () => { collections = {}; return original.removeClient() },
  }
  return { persister, takeCollections }
}

function scrubDehydratedClient(
  client: PersistedClient,
  userId: string | null,
  retired: ReadonlyMap<string, ChannelDiskFence> = new Map(),
  previous?: { snapshot: PersistedClient; changed: ReadonlySet<string> },
  domain: DisplayDomain = "community",
): PersistedClient {
  if (domain === "application") return scrubApplicationClient(client, userId)
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
      ? [{ ...row, preview: "" }]
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
  const retiredIds = new Set(retired.keys())
  const directoryRows = { servers: rows("servers"), channels: retainedChannels, serverMemberships: rows("serverMemberships"), channelMemberships: rows("channelMemberships"), profiles: rows("profiles"), friendships: rows("friendships") }
  const references = new Map<string, AuxiliaryReadReference>()
  if (userId && previous) {
    const previousMembers = previous.snapshot.clientState.queries.flatMap(query => {
      if (!isCommunityDbCollectionKey(query.queryKey) || query.queryKey[2] !== userId || query.queryKey[3] !== "serverMemberships" || !Array.isArray(query.state.data)) return []
      return query.state.data.flatMap((value: unknown) => {
        if (!value || typeof value !== "object" || !("viewer" in value) || value.viewer !== true || !("userId" in value) || value.userId !== userId) return []
        const parsed = communityCollectionSchemas.serverMemberships.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    })
    for (const query of previous.snapshot.clientState.queries) {
      if (query.state.dataUpdatedAt <= 0 || Date.now() - query.state.dataUpdatedAt > PERSIST_MAX_AGE_MS) continue
      const directory = readDirectoryWindow(query.queryKey, query.state.data)
      const bot = directory ? undefined : readBotDirectoryWindow(query.queryKey, query.state.data)
      const display = directory || bot ? undefined : readDisplayWindow(query.queryKey, query.state.data)
      if (!directory && !bot && !display) continue
      const reads = directory ? directory.kind === "members" ? directory.data.pages : [directory.data]
        : bot ? bot.kind === "bot-audit" ? bot.data.pages : [bot.data] : [display!.data]
      const epochs = new Set(reads.flatMap(read => read.auxiliaryReadEpoch ? [read.auxiliaryReadEpoch] : []))
      if (!epochs.size) continue
      references.set(JSON.stringify(query.queryKey), { epochs, changed: previous.changed,
        scopes: directory ? directoryWindowScopeKeys(directory, { serverMemberships: previousMembers }, userId) : bot ? botDirectoryWindowScopeKeys(bot) : displayWindowScopeKeys(display!) })
    }
  }
  type AuxiliaryCandidate = { query: typeof client.clientState.queries[number]; retired: Set<string> } & (
    { family: "directory"; window: DirectoryWindow } | { family: "bot"; window: BotDirectoryWindow } | { family: "display"; window: DisplayWindow }
  )
  const auxiliaryDirectories = userId ? client.clientState.queries.slice().sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
    .flatMap((query): AuxiliaryCandidate[] => {
      const input = readDirectoryWindow(query.queryKey, query.state.data)
      const windowRetired = input && directoryWindowRetiredKeys(input, retired, references.get(JSON.stringify(query.queryKey)))
      const window = input && projectDirectoryWindow(input, directoryRows, windowRetired)
      if (window && directoryWindowComplete(window, directoryRows, userId, windowRetired)) return [{ family: "directory", query, window, retired: windowRetired! }]
      const botWindow = readBotDirectoryWindow(query.queryKey, query.state.data)
      if (!currentDisplayTime(query)) return []
      if (botWindow) {
        const botRetired = botDirectoryWindowRetiredKeys(botWindow, retired, references.get(JSON.stringify(query.queryKey)))
        return botDirectoryWindowComplete(botWindow, directoryRows, userId, botRetired) ? [{ family: "bot", query, window: botWindow, retired: botRetired }] : []
      }
      const display = readDisplayWindow(query.queryKey, query.state.data)
      if (!display) return []
      const displayRetired = displayWindowRetiredKeys(display, retired, references.get(JSON.stringify(query.queryKey)))
      return displayWindowComplete(display, { ...directoryRows, messages: rows("messages") }, userId, domain, displayRetired)
        ? [{ family: "display", query, window: display, retired: displayRetired }] : []
    }).slice(0, MAX_PERSISTED_DIRECTORY_WINDOWS) : []
  const directoryWindows = auxiliaryDirectories.flatMap(candidate => candidate.family === "directory" ? [candidate] : [])
  const botWindows = auxiliaryDirectories.flatMap(candidate => candidate.family === "bot" ? [candidate] : [])
  const displayWindows = auxiliaryDirectories.flatMap(candidate => candidate.family === "display" ? [candidate] : [])
  const directoryServerMemberships = new Set(directoryWindows.flatMap(({ window }) => directoryWindowServerMembershipIds(window)))
  const directoryChannelMemberships = new Set(directoryWindows.flatMap(({ window }) => directoryWindowChannelMembershipIds(window)))
  let forumWindows = 0
  let auxiliaryWindows = 0
  const pageLists = userId ? client.clientState.queries
    .slice().sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt)
    .flatMap(query => {
      const window = readPageListWindow(query.queryKey, query.state.data)
      const auxiliary = window && (window.kind === "pins" || window.kind === "threads" || window.kind === "forum-tags" || window.kind === "forum-counts")
      if (!window || window.kind === "forum" && forumWindows >= 20
        || auxiliary && auxiliaryWindows >= MAX_PERSISTED_MESSAGE_SCOPES
        || !pageListWindowComplete(window, { servers: rows("servers"), channels: retainedChannels, messages: rows("messages"), profiles: rows("profiles"), friendships: rows("friendships") }, retiredIds)) return []
      if (window.kind === "forum") forumWindows++
      if (auxiliary) auxiliaryWindows++
      return [{ query, window }]
    }) : []
  const pageListDependencies = new Set([...pageLists.flatMap(({ window }) => pageListMessageIds(window, retainedChannels, rows("messages"))),
    ...displayWindows.flatMap(({ window }) => window.kind === "reactions" ? [window.messageId] : [])])
  const retainedDmIds = new Set(
    retainedChannels.filter((row) => row.type === "dm").map((row) => row.id),
  )
  const allMessages = retired.size ? rows("messages")
    .filter((row) => !retired.has(row.channelId) && !retired.has(auxiliaryWindowScopeKey({ kind: "message", id: row.id }))) : rows("messages")
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
  const windowRows = { channels: retainedChannels, servers: rows("servers"), channelMemberships: rows("channelMemberships"), messages: allMessages, profiles: rows("profiles") }
  const messageWindows: Array<{ query: typeof client.clientState.queries[number]; window: PersistedMessageWindow }> = []
  const windowScopes = new Set<string>()
  if (userId) for (const query of client.clientState.queries.slice().sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)) {
    if (query.state.status !== "success" && !query.state.dataUpdatedAt) continue
    const candidate = readPersistedMessageWindow(query.queryKey, query.state.data, query.state.dataUpdatedAt)
    const window = candidate && boundPersistedMessageWindow(candidate, allMessages, MAX_PERSISTED_MESSAGES_PER_SCOPE)
    if (!window || windowScopes.has(window.channelId) || windowScopes.size >= MAX_PERSISTED_MESSAGE_SCOPES
      || !persistedMessageWindowComplete(window, windowRows, userId, retiredIds)) continue
    windowScopes.add(window.channelId)
    messageWindows.push({ query, window })
  }
  const ordinaryScopes = [...messagesByScope.values()].map(rows => rows.slice().sort(compareMessagesNewest))
    .sort((a, b) => compareMessagesNewest(a[0]!, b[0]!))
  const messageById = new Map(allMessages.map(row => [row.id, row]))
  const retainedMessages = messageWindows.flatMap(({ window }) => messageWindowMessageIds(window).map(id => messageById.get(id)!))
  const ordinaryScopeIds = new Set(windowScopes)
  for (const scope of ordinaryScopes) {
    const channelId = scope[0]!.channelId
    if (!ordinaryScopeIds.has(channelId) && ordinaryScopeIds.size >= MAX_PERSISTED_MESSAGE_SCOPES) continue
    ordinaryScopeIds.add(channelId)
    const selected = new Set(retainedMessages.filter(row => row.channelId === channelId).map(row => row.id))
    retainedMessages.push(...scope.filter(row => !selected.has(row.id)).slice(0, MAX_PERSISTED_MESSAGES_PER_SCOPE - selected.size))
  }
  const windowDependencies = new Set(messageWindows.flatMap(({ window }) => messageWindowDependencies(window, allMessages)))
  const retainedMessageIds = new Set(retainedMessages.map((row) => row.id))
  for (const message of allMessages) {
    if ((attentionMessageIds.has(message.id) || pageListDependencies.has(message.id) || windowDependencies.has(message.id)) && !retainedMessageIds.has(message.id)) {
      retainedMessages.push(message)
      retainedMessageIds.add(message.id)
    }
  }
  const retainedMessageChannelIds = new Set(retainedMessages.map((row) => row.channelId))
  const durableChannelIds = new Set([...retainedChannelIds, ...retainedMessageChannelIds])
  const retainedServerMemberships = rows("serverMemberships").filter((row) => row.viewer || directoryServerMemberships.has(row.id))
  const channelMemberships = rows("channelMemberships")
  const retainedChannelMemberships = channelMemberships.filter((row) => (
    durableChannelIds.has(row.channelId)
      && (
        row.userId === userId
        || row.relation === "access" && retainedDmIds.has(row.channelId)
        || directoryChannelMemberships.has(row.id)
      )
  ))
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
    profiles: rows("profiles"),
  }
  for (const q of client.clientState.queries) {
    if (!isCommunityDbCollectionKey(q.queryKey)) continue
    if (!userId || q.queryKey[2] !== userId) continue
    const collectionName = q.queryKey[3] as CommunityCollectionName
    const data = windowed[collectionName]
    if (data) queries.push({ ...q, state: { ...q.state, data } })
  }
  for (const { query, window } of pageLists) {
    if (!pageListWindowComplete(window, { servers: rows("servers"), channels: retainedChannels, messages: retainedMessages, profiles: rows("profiles"), friendships: rows("friendships") }, retiredIds)) continue
    queries.push({ ...query, state: { ...query.state, data: window.data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  for (const { query, window, retired: windowRetired } of directoryWindows) {
    if (!userId || !directoryWindowComplete(window, { ...directoryRows, serverMemberships: retainedServerMemberships, channelMemberships: retainedChannelMemberships }, userId, windowRetired)) continue
    queries.push({ ...query, state: { ...query.state, data: window.data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  for (const { query, window, retired: windowRetired } of botWindows) {
    if (!userId || !botDirectoryWindowComplete(window, { ...directoryRows, serverMemberships: retainedServerMemberships }, userId, windowRetired)) continue
    queries.push({ ...query, state: { ...query.state, data: window.data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  for (const { query, window, retired: windowRetired } of displayWindows) {
    if (displayWindowComplete(window, { ...directoryRows, messages: retainedMessages, serverMemberships: retainedServerMemberships, channelMemberships: retainedChannelMemberships }, userId, domain, windowRetired)) queries.push(displayQuery(query, window))
  }
  for (const { query, window } of messageWindows) {
    if (!userId || !persistedMessageWindowComplete(window, { ...windowRows, messages: retainedMessages, channelMemberships: retainedChannelMemberships }, userId, retiredIds)) continue
    queries.push({ ...query, state: { ...query.state, data: window.data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  const qualifiedDirectories = new Map<string, ServerDirectoryWindow>()
  for (const q of client.clientState.queries) {
    if (!userId || !isServerDirectoryWindowKey(q.queryKey)) continue
    const directory = readServerDirectoryWindow(q.state.data)
    if (!directory || directory.serverId !== q.queryKey[2] || directory.channelIds.some(id => retired.has(id))
      || !serverDirectoryWindowComplete(directory, { servers: rows("servers"), categories: rows("categories"), channels: retainedChannels }, userId, directory.serverId)) continue
    qualifiedDirectories.set(directory.serverId, directory)
    queries.push({ ...q, state: { ...q.state, data: directory } })
  }
  const retiredServerIds = new Set(rows("channels").filter(row => retired.has(row.id)).map(row => row.serverId))
  for (const q of client.clientState.queries) {
    if (!userId || !isForumSidebarWindowKey(q.queryKey)) continue
    const data = readForumSidebarWindowResult(q.state.data)
    if (!data || data.window.serverId !== q.queryKey[2] || retiredServerIds.has(data.window.serverId)
      || data.window.parents.some(id => retired.has(id))
      || [...data.window.base, ...(data.window.retained?.disposition === "eligible" ? [data.window.retained.reference] : [])].some(row => retired.has(row.id) || retired.has(row.parentChannelId))
      || !forumSidebarWindowComplete(data.window, { directory: qualifiedDirectories.get(data.window.serverId), servers: rows("servers"), channels: retainedChannels, channelMemberships: retainedChannelMemberships, messages: retainedMessages }, userId, data.window.serverId, null, Date.now() + data.serverClockOffsetMs)) continue
    queries.push({ ...q, state: { ...q.state, data, status: "success", error: null, errorUpdatedAt: 0,
      errorUpdateCount: 0, isInvalidated: true, fetchFailureCount: 0, fetchFailureReason: null, fetchStatus: "idle", fetchMeta: null } })
  }
  return {
    ...client,
    clientState: { ...client.clientState, queries, mutations: [] },
  }
}

export const CACHE_INVALIDATION_STORAGE_KEY = "alook:qc:invalidation"
export const cacheInvalidation = createNativeStore(0)
function publishCacheInvalidation() {
  cacheInvalidation.setState((version) => version + 1)
  try { if (typeof localStorage !== "undefined") localStorage.setItem(CACHE_INVALIDATION_STORAGE_KEY, crypto.randomUUID()) } catch {}
}
export type QualifiedPersister = Persister & { stopPersisting: () => void; rememberAccountIdentity: (identity: PersistedAccountIdentity, assertCurrent: () => void) => Promise<void>; isCurrent: () => Promise<boolean>; retireAccount: () => Promise<void>; retireChannels: (ids: Iterable<string>, deleted?: boolean) => Promise<void>; retireAuxiliaryScopes: (scopes: Iterable<AuxiliaryWindowScope>) => Promise<void>; captureAuxiliaryReadEpoch: () => Promise<string | undefined> }
function isPersistedCacheBlobKey(key: IDBValidKey): key is string {
  return typeof key === "string" && /^alook:(?:qc:[^:]+|business:v\d+):[^:]+(?::application)?:client$/.test(key)
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
    const { version, channelFences, ownerEpochs, ...snapshot } = JSON.parse(raw) as PersistedClient & { version?: unknown; channelFences?: unknown; ownerEpochs?: { device?: unknown; account?: unknown } }
    if (version !== PERSIST_VERSION || snapshot.buster !== PERSIST_BUSTER || !ownerEpochs || !isEpoch(ownerEpochs.device) || !isEpoch(ownerEpochs.account) || !Array.isArray(channelFences)
      || !channelFences.every((entry) => Array.isArray(entry) && entry.length === 2)) return undefined
    const fences = new Map(channelFences)
    return isChannelFences(fences) ? { snapshot, fences, ownerEpochs: { device: ownerEpochs.device, account: ownerEpochs.account } } : undefined
  } catch { return undefined }
}

export async function readPersistedAccountIdentity(): Promise<PersistedAccountIdentity | undefined> {
  return cacheTransaction("readonly", async store => {
    const identity = await readPersistedAccountClaim(store)
    if (!identity) return undefined
    const key = blobKeyFor(identity.id)
    const current = await readEligibility(store, key, identity.id)
    if (current.device !== identity.device || current.account !== identity.account
      || communityScopeEpoch(current.scope) !== identity.scope || !isChannelFences(current.channels)) return undefined
    const decoded = decodeDiskSnapshot(await promisifyRequest<unknown>(store.get(key)))
    if (!decoded || decoded.ownerEpochs.device !== identity.device || decoded.ownerEpochs.account !== identity.account) return undefined
    const restored = readCommunityRestoredCollections(decoded.snapshot, identity.id)
    const self = CommunitySelfProfileReadSchema.strip().safeParse(restored.profiles?.rows.find(profile => profile.id === identity.id))
    if (!self.success || self.data.id !== identity.id) return undefined
    return { id: identity.id, email: identity.email }
  })
}

export async function retirePersistedAccountIdentity(identity: AccountIdentityRecord, assertCurrent: () => void): Promise<void> {
  const retired = await cacheTransaction("readwrite", async store => {
    const current = await readEligibility(store, blobKeyFor(identity.id), identity.id)
    assertCurrent()
    if (current.device !== identity.device || current.account !== identity.account || communityScopeEpoch(current.scope) !== identity.scope) return false
    await clearAccountRows(store, identity.id)
    return true
  })
  if (retired) publishCacheInvalidation()
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
function qualifyPersister(key: string, userId: string | null, captureSnapshot: (raw: string, decoded: NonNullable<ReturnType<typeof decodeDiskSnapshot>>) => void): Promise<PersistEligibility> {
  return cacheTransaction("readwrite", async (store) => {
    await clearAccountRows(store, userId, true)
    const raw = await promisifyRequest<unknown>(store.get(key))
    const current = await readEligibility(store, key, userId)
    const device = isEpoch(current.device) ? current.device : crypto.randomUUID()
    const intact = isEpoch(current.account) && isChannelFences(current.channels)
    const account = intact ? current.account as string : crypto.randomUUID()
    const channels = intact ? current.channels as Map<string, ChannelDiskFence> : new Map<string, ChannelDiskFence>()
    const currentScope = communityScopeEpoch(current.scope)
    const decoded = decodeDiskSnapshot(raw)
    const compatiblePayload = raw === undefined || Boolean(decoded && decoded.ownerEpochs.device === device && decoded.ownerEpochs.account === account)
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
    if (intact && isEpoch(current.device) && currentScope && compatiblePayload && decoded && typeof raw === "string") captureSnapshot(raw, decoded)
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

function boundDomainWindows(payloads: Array<{ domain: DisplayDomain; snapshot: PersistedClient }>) {
  const auxiliary = (query: PersistedQuery, domain: DisplayDomain) => readDisplayWindow(query.queryKey, query.state.data)?.domain === domain
    || domain === "community" && (readDirectoryWindow(query.queryKey, query.state.data) !== undefined || readBotDirectoryWindow(query.queryKey, query.state.data) !== undefined)
  const identity = (domain: DisplayDomain, query: PersistedQuery) => JSON.stringify([domain, query.queryKey])
  const allowed = new Set(payloads.flatMap(({ domain, snapshot }) => snapshot.clientState.queries
    .filter(query => auxiliary(query, domain)).map(query => ({ identity: identity(domain, query), time: query.state.dataUpdatedAt })))
    .sort((a, b) => b.time - a.time || a.identity.localeCompare(b.identity)).slice(0, MAX_PERSISTED_DIRECTORY_WINDOWS).map(row => row.identity))
  return payloads.map(({ domain, snapshot }) => ({ ...snapshot, clientState: { ...snapshot.clientState, mutations: [],
    queries: snapshot.clientState.queries.filter(query => !auxiliary(query, domain) || allowed.has(identity(domain, query))) } }))
}

/** Native TanStack persister, qualified against durable device/account epochs. */
export function createIdbPersister(userId: string | null, domain: DisplayDomain = "community"): QualifiedPersister {
  const key = blobKeyFor(userId, domain)
  let persisting = true
  let initialSnapshot: { raw: string; decoded: NonNullable<ReturnType<typeof decodeDiskSnapshot>> } | undefined
  let captureInitialSnapshot = true
  const discardInitialSnapshot = () => { captureInitialSnapshot = false; initialSnapshot = undefined }
  const eligibility = qualifyPersister(key, userId, (raw, decoded) => { if (captureInitialSnapshot) initialSnapshot = { raw, decoded } })
  // An unavailable IDB must also fail restore through the provider's onError;
  // attach a handler immediately so qualification cannot reject unobserved.
  void eligibility.catch(() => undefined)
  const writer = createAsyncStoragePersister({
    storage: {
      getItem: (get<string>).bind(undefined, key, cacheStore),
      setItem: (_k: string, value: string) => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store, current, expected) => {
          if (!persisting) return
          const { device, account } = await eligibility
          const prior = decodeDiskSnapshot(await promisifyRequest<unknown>(store.get(key)))
          const reference = prior && prior.ownerEpochs.device === device && prior.ownerEpochs.account === account && prior.snapshot.buster === PERSIST_BUSTER
            && Date.now() - prior.snapshot.timestamp <= PERSIST_MAX_AGE_MS
            ? { snapshot: prior.snapshot, changed: new Set(changedChannelFences(current, prior.fences).keys()) } : undefined
          const snapshot = scrubDehydratedClient(JSON.parse(value) as PersistedClient, userId, changedChannelFences(current, expected), reference, domain)
          const peerDomain: DisplayDomain = domain === "community" ? "application" : "community"
          const peerKey = blobKeyFor(userId, peerDomain)
          const [peerRaw, peerScope] = await Promise.all([promisifyRequest<unknown>(store.get(peerKey)), promisifyRequest<unknown>(store.get(scopeEpochKey(peerKey)))])
          const peer = decodeDiskSnapshot(peerRaw)
          const qualifiedPeer = peer && communityScopeEpoch(peerScope) && peer.ownerEpochs.device === device && peer.ownerEpochs.account === account
            && peer.snapshot.timestamp > 0 && Date.now() - peer.snapshot.timestamp <= PERSIST_MAX_AGE_MS ? peer : undefined
          const [bounded, boundedPeer] = boundDomainWindows([{ domain, snapshot }, ...(qualifiedPeer ? [{ domain: peerDomain, snapshot: qualifiedPeer.snapshot }] : [])])
          if (persisting) {
            store.put(JSON.stringify({ ...bounded, version: PERSIST_VERSION, ownerEpochs: { device, account }, channelFences: [...current] }), key)
            if (qualifiedPeer && boundedPeer && boundedPeer.clientState.queries.length !== qualifiedPeer.snapshot.clientState.queries.length)
              store.put(JSON.stringify({ ...boundedPeer, version: PERSIST_VERSION, ownerEpochs: qualifiedPeer.ownerEpochs, channelFences: [...qualifiedPeer.fences] }), peerKey)
          }
        },
      ),
      // Expiry/buster removal removes only this payload. It does not retire
      // the owner, so its subsequent fresh network results can persist.
      removeItem: () => withEligiblePersister(
        key, userId, eligibility, "readwrite", undefined, async (store) => { if (persisting) store.delete(key) },
      ),
    },
    key: "alook-query-cache",
    serialize: (client) => JSON.stringify(scrubDehydratedClient(client, userId, undefined, undefined, domain)),
  })
  const persister: Persister = {
    persistClient: (client) => { if (!persisting) return; discardInitialSnapshot(); return writer.persistClient(client) },
    restoreClient: async () => {
      try {
        const input = await observeRestoreRead(() => withEligiblePersister(key, userId, eligibility, "readwrite", undefined, async (store, current) => {
          const raw = await promisifyRequest<unknown>(store.get(key))
          const decoded = initialSnapshot && initialSnapshot.raw === raw ? initialSnapshot.decoded : decodeDiskSnapshot(raw)
          discardInitialSnapshot()
          const expected = await eligibility
          if (!decoded || decoded.ownerEpochs.device !== expected.device || decoded.ownerEpochs.account !== expected.account) { store.delete(key); return undefined }
          return { ...decoded, retired: changedChannelFences(current, decoded.fences) }
        }), persister)
        return input && observeRestoreDecode(persister, () => {
          const snapshot = scrubDehydratedClient(input.snapshot, userId, input.retired, undefined, domain)
          if (!snapshot.timestamp || Date.now() - snapshot.timestamp <= PERSIST_MAX_AGE_MS) return snapshot
          if (domain === "application") return snapshot
          const profiles = snapshot.clientState.queries.filter(query => isCommunityDbCollectionKey(query.queryKey)
            && query.queryKey[2] === userId && query.queryKey[3] === "profiles" && Array.isArray(query.state.data) && query.state.data.length > 0)
          return profiles.length ? { ...snapshot, timestamp: Date.now(), clientState: { queries: profiles, mutations: [] } } : snapshot
        }, PERSIST_BUSTER, PERSIST_MAX_AGE_MS)
      } finally { discardInitialSnapshot() }
    },
    removeClient: () => { if (!persisting) return; discardInitialSnapshot(); return writer.removeClient() },
  }
  return Object.assign(persister, {
    stopPersisting: () => { persisting = false },
    rememberAccountIdentity: (identity: PersistedAccountIdentity, assertCurrent: () => void) => withEligiblePersister(
      key, userId, eligibility, "readwrite", undefined, async store => {
        assertCurrent()
        if (domain !== "community" || identity.id !== userId || !identity.email) return
        const { device, account, scope } = await eligibility
        assertCurrent()
        store.put({ id: identity.id, email: identity.email, version: PERSIST_VERSION, device, account, scope }, LAST_ACCOUNT_KEY)
      },
    ),
    isCurrent: () => withEligiblePersister(key, userId, eligibility, "readonly", false, async () => true),
    retireChannels: (ids: Iterable<string>, deleted = false) => {
      discardInitialSnapshot()
      return withEligiblePersister(key, userId, eligibility, "readwrite", undefined, (store, current) => retireChannelRows(store, key, userId, current, ids, deleted, domain))
    },
    retireAuxiliaryScopes: (scopes: Iterable<AuxiliaryWindowScope>) => {
      discardInitialSnapshot()
      const ids = [...scopes].map(auxiliaryWindowScopeKey)
      if (!ids.length) return Promise.resolve()
      ids.push(AUXILIARY_READ_EPOCH_KEY)
      return withEligiblePersister(key, userId, eligibility, "readwrite", undefined, (store, current) => retireChannelRows(store, key, userId, current, ids, true, domain))
    },
    captureAuxiliaryReadEpoch: () => withEligiblePersister(key, userId, eligibility, "readonly", undefined, (_store, current) => Promise.resolve(current.get(AUXILIARY_READ_EPOCH_KEY)?.epoch)).catch(() => undefined),
    retireAccount: async () => {
      discardInitialSnapshot()
      const retired = await withEligiblePersister(key, userId, eligibility, "readwrite", false, async (store) => { await clearAccountRows(store, userId); return true })
      if (retired) publishCacheInvalidation()
    },
  })
}

async function clearAccountRows(store: IDBObjectStore, userId: string | null, legacyOnly = false): Promise<void> {
  if (!legacyOnly) {
    const identity = accountIdentityRecord(await promisifyRequest<unknown>(store.get(LAST_ACCOUNT_KEY)))
    if (identity?.id === userId) store.delete(LAST_ACCOUNT_KEY)
    store.put(crypto.randomUUID(), accountEpochKey(userId))
    store.put(new Map(), channelFenceKey(userId))
    for (const domain of ["community", "application"] as const) {
      const key = blobKeyFor(userId, domain)
      store.put(crypto.randomUUID(), scopeEpochKey(key))
      store.delete(key)
    }
  }
  await new Promise<void>((resolve, reject) => {
    const request = store.openKeyCursor()
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { resolve(); return }
      const match = typeof cursor.key === "string" && /^(alook:(?:qc:[^:]+|business:v[1-9]\d*)):([^:]+):((?:application:)?client(?::epoch)?|account-epoch(?::channels)?)$/.exec(cursor.key)
      if (match && match[2] === (userId ?? "anon")) {
        const version = /^alook:(?:business|qc):v([1-9]\d*)$/.exec(match[1])
        const older = match[1] === PERSIST_ACCOUNT_PREFIX || Boolean(version && Number.isSafeInteger(Number(version[1])) && Number(version[1]) < PERSIST_VERSION)
        const payload = match[3].startsWith("client") || match[3].startsWith("application:client")
        if (legacyOnly ? older && payload : older || match[1] === IDB_PREFIX) {
          if (match[3] === "account-epoch:channels") store.put(new Map(), cursor.key)
          else if (match[3].endsWith("epoch")) store.put(crypto.randomUUID(), cursor.key)
          else store.delete(cursor.key)
        }
      }
      cursor.continue()
    }
  })
}

async function retireChannelRows(store: IDBObjectStore, key: string, userId: string | null, current: Map<string, ChannelDiskFence>, ids: Iterable<string>, deleted: boolean, domain: DisplayDomain = "community") {
  const scopes = [...ids]
  if (!scopes.length) return
  await clearAccountRows(store, userId, true)
  const fences = new Map(current)
  for (const id of scopes) fences.set(id, { epoch: crypto.randomUUID(), deleted: deleted || fences.get(id)?.deleted === true })
  store.put(fences, channelFenceKey(userId))
  const decoded = decodeDiskSnapshot(await promisifyRequest<unknown>(store.get(key)))
  if (decoded) {
    const snapshot = scrubDehydratedClient(decoded.snapshot, userId, changedChannelFences(fences, decoded.fences), undefined, domain)
    store.put(JSON.stringify({ ...snapshot, version: PERSIST_VERSION, ownerEpochs: decoded.ownerEpochs, channelFences: [...fences] }), key)
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
    store.delete(LAST_ACCOUNT_KEY)
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
