import { clearPersistedCache } from "@/lib/query-persister"
import {
  DbClient,
  BasicIndex,
  collectionOptions,
} from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import type { QueryClient, QueryFunctionContext } from "@tanstack/react-query"
import { createStore } from "@tanstack/store"
import { createCommunityStore } from "@/stores/community/ui-store"
import { createCommunityWsStore } from "@/stores/community/ws-store"
import { createMessageStreamStore } from "@/stores/community/message-stream-store"
import { createOwnerServerDeleteStore, emptyOwnerServerDeleteState } from "@/lib/community/eject-server"
import { cancelActiveConversationNavigationProof } from "@/lib/community/conversation-navigation-proof"
import type { CanonicalMessage } from "@/lib/community/message-stream"
import { communityKeys } from "@/lib/query-keys"
import {
  categorySchema,
  attentionItemSchema,
  attentionScopeSchema,
  channelMembershipSchema,
  channelSchema,
  folderItemSchema,
  folderSchema,
  messageSchema,
  friendshipSchema,
  notificationSettingSchema,
  profileSchema,
  readStateClockSchema,
  readStateSchema,
  serverMembershipSchema,
  serverSchema,
  type CategoryRow,
  type AttentionItemRow,
  type AttentionScopeRow,
  type ChannelMembershipRow,
  type ChannelRow,
  type FolderItemRow,
  type FolderRow,
  type MessageRow,
  type FriendshipRow,
  type NotificationSettingRow,
  type ProfileRow,
  type ReadStateClockRow,
  type ReadStateRow,
  type ServerMembershipRow,
  type ServerRow,
} from "./schema"

const QUERY_CACHE_GC_TIME = 24 * 60 * 60 * 1000

function collectionQueryKey(accountId: string, name: string) {
  return communityKeys.communityDbCollection(accountId, name)
}

function restoredRows<T extends object>(
  queryClient: QueryClient,
  accountId: string,
  name: string,
) {
  return queryClient.getQueryData<T[]>(collectionQueryKey(accountId, name)) ?? []
}

function migrateLegacyServerPositions(queryClient: QueryClient, accountId: string) {
  const key = collectionQueryKey(accountId, "servers")
  const rows = queryClient.getQueryData<ServerRow[]>(key)
  if (!rows?.some((row) => row.position === undefined)) return
  const updatedAt = queryClient.getQueryState(key)!.dataUpdatedAt
  queryClient.setQueryData(key, rows.map((row, position) => ({
    ...row,
    position: row.position ?? position,
  })), { updatedAt })
}

function buildCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: { waitForRestore?: Promise<void> } = {},
) {
  const scopeId = accountId ?? "anon"
  const dbClient = new DbClient({ queryClient })
  const waitForRestore = options.waitForRestore ?? Promise.resolve()
  const queryFnFor = <T extends object>(name: string) => async ({ signal }: QueryFunctionContext) => {
    const generation = runtime.lifecycle.get().generation
    await waitForRestore
    const state = runtime.lifecycle.get()
    if (!state.active || state.generation !== generation || signal.aborted) throw new DOMException("Retired collection restore", "AbortError")
    return restoredRows<T>(queryClient, scopeId, name)
  }

  const servers = dbClient.collection(collectionOptions("community-db-servers", () => ({
    ...queryCollectionOptions({
      id: "community-db-servers",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "servers"),
      queryFn: queryFnFor<ServerRow>("servers"),
      schema: serverSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const categories = dbClient.collection(collectionOptions("community-db-categories", () => ({
    ...queryCollectionOptions({
      id: "community-db-categories",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "categories"),
      queryFn: queryFnFor<CategoryRow>("categories"),
      schema: categorySchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const channels = dbClient.collection(collectionOptions("community-db-channels", () => ({
    ...queryCollectionOptions({
      id: "community-db-channels",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "channels"),
      queryFn: queryFnFor<ChannelRow>("channels"),
      schema: channelSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const serverMemberships = dbClient.collection(collectionOptions("community-db-server-memberships", () => ({
    ...queryCollectionOptions({
      id: "community-db-server-memberships",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "serverMemberships"),
      queryFn: queryFnFor<ServerMembershipRow>("serverMemberships"),
      schema: serverMembershipSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const channelMemberships = dbClient.collection(collectionOptions("community-db-channel-memberships", () => ({
    ...queryCollectionOptions({
      id: "community-db-channel-memberships",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "channelMemberships"),
      queryFn: queryFnFor<ChannelMembershipRow>("channelMemberships"),
      schema: channelMembershipSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const profiles = dbClient.collection(collectionOptions("community-db-profiles", () => ({
    ...queryCollectionOptions({
      id: "community-db-profiles",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "profiles"),
      queryFn: queryFnFor<ProfileRow>("profiles"),
      schema: profileSchema,
      getKey: (row) => row.userId,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const messages = dbClient.collection(collectionOptions("community-db-messages", () => ({
    ...queryCollectionOptions({
      id: "community-db-messages",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "messages"),
      queryFn: queryFnFor<MessageRow>("messages"),
      schema: messageSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const readStates = dbClient.collection(collectionOptions("community-db-read-states", () => ({
    ...queryCollectionOptions({
      id: "community-db-read-states",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "readStates"),
      queryFn: queryFnFor<ReadStateRow>("readStates"),
      schema: readStateSchema,
      getKey: (row) => row.channelId,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const readStateClock = dbClient.collection(collectionOptions("community-db-read-state-clock", () => ({
    ...queryCollectionOptions({
      id: "community-db-read-state-clock",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "readStateClock"),
      queryFn: queryFnFor<ReadStateClockRow>("readStateClock"),
      schema: readStateClockSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const attentionScopes = dbClient.collection(collectionOptions("community-db-attention-scopes", () => ({
    ...queryCollectionOptions({
      id: "community-db-attention-scopes",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "attentionScopes"),
      queryFn: queryFnFor<AttentionScopeRow>("attentionScopes"),
      schema: attentionScopeSchema,
      getKey: (row) => row.scopeId,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const attentionItems = dbClient.collection(collectionOptions("community-db-attention-items", () => ({
    ...queryCollectionOptions({
      id: "community-db-attention-items",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "attentionItems"),
      queryFn: queryFnFor<AttentionItemRow>("attentionItems"),
      schema: attentionItemSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const folders = dbClient.collection(collectionOptions("community-db-folders", () => ({
    ...queryCollectionOptions({
      id: "community-db-folders",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "folders"),
      queryFn: queryFnFor<FolderRow>("folders"),
      schema: folderSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const folderItems = dbClient.collection(collectionOptions("community-db-folder-items", () => ({
    ...queryCollectionOptions({
      id: "community-db-folder-items",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "folderItems"),
      queryFn: queryFnFor<FolderItemRow>("folderItems"),
      schema: folderItemSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))
  const notificationSettings = dbClient.collection(collectionOptions("community-db-notification-settings", () => ({
    ...queryCollectionOptions({
      id: "community-db-notification-settings",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "notificationSettings"),
      queryFn: queryFnFor<NotificationSettingRow>("notificationSettings"),
      schema: notificationSettingSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: QUERY_CACHE_GC_TIME,
      persistedGcTime: QUERY_CACHE_GC_TIME,
    }),
    gcTime: 0,
  })))

  const friendships = dbClient.collection(collectionOptions("community-db-friendships", () => ({
    ...queryCollectionOptions({ id: "community-db-friendships", queryClient, queryKey: collectionQueryKey(scopeId, "friendships"), queryFn: queryFnFor<FriendshipRow>("friendships"), schema: friendshipSchema, getKey: (row) => row.id, staleTime: Infinity, gcTime: QUERY_CACHE_GC_TIME, persistedGcTime: QUERY_CACHE_GC_TIME }), gcTime: 0,
  })))

  const collections = {
    servers,
    categories,
    channels,
    serverMemberships,
    channelMemberships,
    profiles,
    messages,
    friendships,
    readStates,
    readStateClock,
    attentionScopes,
    attentionItems,
    folders,
    folderItems,
    notificationSettings,
  } as const
  channels.createIndex((row) => row.parentMessageId, { indexType: BasicIndex })
  messages.createIndex((row) => row.seq, { indexType: BasicIndex })
  type CollectionName = keyof typeof collections
  const restoration = createStore({ captured: false, names: new Set<string>(), hasData: false })
  const runtime = {
    ui: createCommunityStore(), ws: createCommunityWsStore(accountId), messageStream: createMessageStreamStore(() => new Map(Array.from(messages.values()).flatMap((message) => typeof message.seq === "number" ? [[message.id, message as CanonicalMessage] as const] : []))),
    serverEject: createOwnerServerDeleteStore(),
    lifecycle: createStore({ active: true, generation: 0 }), transport: { send: null as ((message: object) => void) | null },
  }

  const authenticationBindings = createStore({ retireDisk: () => clearPersistedCache(accountId), sessionViewer: () => accountId as string | null | undefined })
  const registry = {
    accountId,
    authenticationView: createStore({ active: false, generation: 0 }),
    retireDisk: () => authenticationBindings.get().retireDisk(),
    sessionViewer: () => authenticationBindings.get().sessionViewer(),
    bindAuthentication: (sessionViewer: () => string | null | undefined, retireDisk: () => Promise<void>) => authenticationBindings.setState(() => ({ sessionViewer, retireDisk })),
    scopeId,
    queryClient,
    dbClient,
    ready: waitForRestore,
    collections,
    runtime,
    restoration,
    serverListAuthority: createStore<{
      viewerId: string | null; accountEpoch: number; accessEpoch: number; ownerGeneration: number; serverIdsSignature: string
    } | null>(null),
    captureRestoredCollections: () => {
      if (restoration.get().captured) return
      const names = new Set<string>()
      let hasData = false
      migrateLegacyServerPositions(queryClient, scopeId)
      for (const name of Object.keys(collections) as CollectionName[]) {
        const snapshot = queryClient.getQueryState(collectionQueryKey(scopeId, name))
        const data = snapshot?.data
        if (snapshot && data !== undefined && snapshot.dataUpdatedAt > 0) {
          names.add(name)
          if (Array.isArray(data) && data.length > 0) hasData = true
        }
      }
      restoration.setState(() => ({ captured: true, names, hasData }))
    },
    hasRestoredCollection: (name: CollectionName) => restoration.get().names.has(name),
    hasRestoredData: () => restoration.get().hasData,
    preload: () => Promise.all(Object.values(collections).map((collection) => collection.preload())),
    cleanup: () => {
      cancelActiveConversationNavigationProof(queryClient)
      if (registryByQueryClient.get(queryClient) === registry) registryByQueryClient.delete(queryClient)
      runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
      runtime.transport.send = null
      runtime.serverEject.setState(emptyOwnerServerDeleteState)
      registry.serverListAuthority.setState(() => null)
      runtime.ui.actions.reset()
      runtime.ws.actions.reset()
      runtime.messageStream.actions.resetAll()
      return dbClient.cleanup()
    },
  }
  return registry
}

export type CommunityDbRegistry = ReturnType<typeof buildCommunityDbRegistry>

export function createCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: { waitForRestore?: Promise<void> } = {},
): CommunityDbRegistry {
  const existing = registryByQueryClient.get(queryClient)
  if (existing) {
    if (existing.accountId !== accountId) throw new Error("A community QueryClient belongs to one account")
    return existing
  }
  const registry = buildCommunityDbRegistry(queryClient, accountId, options)
  registryByQueryClient.set(queryClient, registry)
  return registry
}

const registryByQueryClient = new WeakMap<QueryClient, CommunityDbRegistry>()

export function registerCommunityDbRegistry(registry: CommunityDbRegistry) {
  registryByQueryClient.set(registry.queryClient, registry)
  registry.runtime.lifecycle.setState((state) => ({ ...state, active: true }))
  return () => {
    cancelActiveConversationNavigationProof(registry.queryClient)
    registry.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
  }
}

export function getCommunityDbRegistry(queryClient: QueryClient) {
  return registryByQueryClient.get(queryClient) ?? null
}
