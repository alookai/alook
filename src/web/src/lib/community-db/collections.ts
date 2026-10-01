import {
  DbClient,
  collectionOptions,
} from "@tanstack/react-db"
import { queryCollectionOptions } from "@tanstack/query-db-collection"
import type { DehydratedState, QueryClient } from "@tanstack/react-query"
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
  type NotificationSettingRow,
  type ProfileRow,
  type ReadStateClockRow,
  type ReadStateRow,
  type ServerMembershipRow,
  type ServerRow,
} from "./schema"

const COLLECTION_GC_TIME = 24 * 60 * 60 * 1000

export type PendingRouteChannel = Pick<ChannelRow, "id" | "serverId" | "type"> & {
  authority: "pending"
} & { [K in Exclude<keyof ChannelRow, "id" | "serverId" | "type">]?: never }

export type RestoredScopeDecision =
  | { kind: "server-list"; ids: string[] }
  | { kind: "server"; id: string; channelIds: string[] }
  | { kind: "dms"; channelIds: string[] }
  | { kind: "channel"; id: string }
  | { kind: "denied-server" | "denied-channel"; id: string }

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
  queryClient.setQueryData(key, rows.map((row, position) => ({
    ...row,
    position: row.position ?? position,
  })))
}

export function createCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: { waitForRestore?: Promise<void> } = {},
) {
  const scopeId = accountId ?? "anon"
  const dbClient = new DbClient({ queryClient })
  const waitForRestore = options.waitForRestore ?? Promise.resolve()
  const queryFnFor = <T extends object>(name: string) => async () => {
    await waitForRestore
    return restoredRows<T>(queryClient, scopeId, name)
  }

  const servers = dbClient.collection(collectionOptions("community-db-servers", () => (
    queryCollectionOptions({
      id: "community-db-servers",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "servers"),
      queryFn: queryFnFor<ServerRow>("servers"),
      schema: serverSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const categories = dbClient.collection(collectionOptions("community-db-categories", () => (
    queryCollectionOptions({
      id: "community-db-categories",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "categories"),
      queryFn: queryFnFor<CategoryRow>("categories"),
      schema: categorySchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const channels = dbClient.collection(collectionOptions("community-db-channels", () => (
    queryCollectionOptions({
      id: "community-db-channels",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "channels"),
      queryFn: queryFnFor<ChannelRow>("channels"),
      schema: channelSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const serverMemberships = dbClient.collection(collectionOptions("community-db-server-memberships", () => (
    queryCollectionOptions({
      id: "community-db-server-memberships",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "serverMemberships"),
      queryFn: queryFnFor<ServerMembershipRow>("serverMemberships"),
      schema: serverMembershipSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const channelMemberships = dbClient.collection(collectionOptions("community-db-channel-memberships", () => (
    queryCollectionOptions({
      id: "community-db-channel-memberships",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "channelMemberships"),
      queryFn: queryFnFor<ChannelMembershipRow>("channelMemberships"),
      schema: channelMembershipSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const profiles = dbClient.collection(collectionOptions("community-db-profiles", () => (
    queryCollectionOptions({
      id: "community-db-profiles",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "profiles"),
      queryFn: queryFnFor<ProfileRow>("profiles"),
      schema: profileSchema,
      getKey: (row) => row.userId,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const messages = dbClient.collection(collectionOptions("community-db-messages", () => (
    queryCollectionOptions({
      id: "community-db-messages",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "messages"),
      queryFn: queryFnFor<MessageRow>("messages"),
      schema: messageSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const readStates = dbClient.collection(collectionOptions("community-db-read-states", () => (
    queryCollectionOptions({
      id: "community-db-read-states",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "readStates"),
      queryFn: queryFnFor<ReadStateRow>("readStates"),
      schema: readStateSchema,
      getKey: (row) => row.channelId,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const readStateClock = dbClient.collection(collectionOptions("community-db-read-state-clock", () => (
    queryCollectionOptions({
      id: "community-db-read-state-clock",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "readStateClock"),
      queryFn: queryFnFor<ReadStateClockRow>("readStateClock"),
      schema: readStateClockSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const attentionScopes = dbClient.collection(collectionOptions("community-db-attention-scopes", () => (
    queryCollectionOptions({
      id: "community-db-attention-scopes",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "attentionScopes"),
      queryFn: queryFnFor<AttentionScopeRow>("attentionScopes"),
      schema: attentionScopeSchema,
      getKey: (row) => row.scopeId,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const attentionItems = dbClient.collection(collectionOptions("community-db-attention-items", () => (
    queryCollectionOptions({
      id: "community-db-attention-items",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "attentionItems"),
      queryFn: queryFnFor<AttentionItemRow>("attentionItems"),
      schema: attentionItemSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const folders = dbClient.collection(collectionOptions("community-db-folders", () => (
    queryCollectionOptions({
      id: "community-db-folders",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "folders"),
      queryFn: queryFnFor<FolderRow>("folders"),
      schema: folderSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const folderItems = dbClient.collection(collectionOptions("community-db-folder-items", () => (
    queryCollectionOptions({
      id: "community-db-folder-items",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "folderItems"),
      queryFn: queryFnFor<FolderItemRow>("folderItems"),
      schema: folderItemSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))
  const notificationSettings = dbClient.collection(collectionOptions("community-db-notification-settings", () => (
    queryCollectionOptions({
      id: "community-db-notification-settings",
      queryClient,
      queryKey: collectionQueryKey(scopeId, "notificationSettings"),
      queryFn: queryFnFor<NotificationSettingRow>("notificationSettings"),
      schema: notificationSettingSchema,
      getKey: (row) => row.id,
      staleTime: Infinity,
      gcTime: COLLECTION_GC_TIME,
      persistedGcTime: COLLECTION_GC_TIME,
    })
  )))

  const collections = {
    servers,
    categories,
    channels,
    serverMemberships,
    channelMemberships,
    profiles,
    messages,
    readStates,
    readStateClock,
    attentionScopes,
    attentionItems,
    folders,
    folderItems,
    notificationSettings,
  } as const
  type CollectionName = keyof typeof collections
  const restoredCollectionNames = new Set<CollectionName>()
  const restoredCollectionListeners = new Set<() => void>()
  let restoredSnapshotCaptured = false
  let restoredDataExists = false
  let restoredScopeListener: ((decision: RestoredScopeDecision) => void) | undefined
  const pendingRouteTypes = new Map<string, PendingRouteChannel>()
  const pendingLandingIds = new Map<string, string[]>()
  const pendingRouteParents = new Map<string, string | null | undefined>()
  const pendingRouteListeners = new Set<() => void>()
  const notifyPendingRoutes = () => { for (const listener of pendingRouteListeners) listener() }

  return {
    accountId,
    scopeId,
    queryClient,
    dbClient,
    collections,
    setRestoredScopeListener: (listener: (decision: RestoredScopeDecision) => void) => { restoredScopeListener = listener },
    settleRestoredScope: (decision: RestoredScopeDecision) => restoredScopeListener?.(decision),
    stageRestoredRouteTypes: (snapshot: DehydratedState) => {
      pendingRouteTypes.clear()
      pendingRouteParents.clear()
      pendingLandingIds.clear()
      const categoryQuery = snapshot.queries.find((query) => query.queryKey[2] === scopeId && query.queryKey[3] === "categories")
      const parsedCategories = categorySchema.array().safeParse(categoryQuery?.state.data)
      const categoryPositions = new Map((parsedCategories.success ? parsedCategories.data : []).map((row) => [row.id, row.position]))
      const query = snapshot.queries.find((query) => query.queryKey.length === 4
        && query.queryKey[0] === "community" && query.queryKey[1] === "db"
        && query.queryKey[2] === scopeId && query.queryKey[3] === "channels")
      const parsed = channelSchema.array().safeParse(query?.state.data)
      for (const row of parsed.success ? parsed.data : []) {
        if (row.type !== "dm") {
          pendingRouteTypes.set(row.id, { id: row.id, serverId: row.serverId, type: row.type, authority: "pending" })
          pendingRouteParents.set(row.id, row.parentChannelId)
        }
      }
      for (const row of (parsed.success ? parsed.data : []).filter((row) => row.serverId && !row.parentChannelId)
        .sort((a, b) => (categoryPositions.get(a.categoryId ?? "") ?? Infinity) - (categoryPositions.get(b.categoryId ?? "") ?? Infinity)
          || a.position - b.position)) {
        const ids = pendingLandingIds.get(row.serverId!) ?? []
        ids.push(row.id)
        pendingLandingIds.set(row.serverId!, ids)
      }
      notifyPendingRoutes()
    },
    getPendingLandingChannel: (serverId: string, remembered: string | null) => {
      const id = remembered ?? pendingLandingIds.get(serverId)?.find((id) => pendingRouteTypes.has(id))
      const row = id ? pendingRouteTypes.get(id) : undefined
      return row?.serverId === serverId ? row : undefined
    },
    getPendingRouteType: (id: string) => pendingRouteTypes.get(id),
    removePendingRouteTypes: (ids: Iterable<string>) => {
      for (const id of ids) { pendingRouteTypes.delete(id); pendingRouteParents.delete(id) }
      notifyPendingRoutes()
    },
    removePendingRouteScope: (scope: { kind: "server" | "channel"; id: string }) => {
      const ids = new Set(scope.kind === "channel" ? [scope.id] : [...pendingRouteTypes.values()]
        .filter((row) => row.serverId === scope.id).map((row) => row.id))
      let changed = true
      while (changed) {
        changed = false
        for (const [id, parent] of pendingRouteParents) if (parent && ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true }
      }
      for (const id of ids) { pendingRouteTypes.delete(id); pendingRouteParents.delete(id) }
      notifyPendingRoutes()
    },
    subscribePendingRouteTypes: (listener: () => void) => {
      pendingRouteListeners.add(listener)
      return () => pendingRouteListeners.delete(listener)
    },
    captureRestoredCollections: () => {
      if (restoredSnapshotCaptured) return
      restoredSnapshotCaptured = true
      migrateLegacyServerPositions(queryClient, scopeId)
      for (const name of Object.keys(collections) as CollectionName[]) {
        const data = queryClient.getQueryData(collectionQueryKey(scopeId, name))
        if (data !== undefined) {
          restoredCollectionNames.add(name)
          if (Array.isArray(data) && data.length > 0) restoredDataExists = true
        }
      }
      for (const listener of restoredCollectionListeners) listener()
    },
    hasRestoredCollection: (name: CollectionName) => restoredCollectionNames.has(name),
    hasRestoredData: () => restoredDataExists,
    subscribeRestoredCollections: (listener: () => void) => {
      restoredCollectionListeners.add(listener)
      return () => restoredCollectionListeners.delete(listener)
    },
    preload: () => Promise.all(Object.values(collections).map((collection) => collection.preload())),
    cleanup: () => dbClient.cleanup(),
  }
}

export type CommunityDbRegistry = ReturnType<typeof createCommunityDbRegistry>

const registryByQueryClient = new WeakMap<QueryClient, CommunityDbRegistry>()
let activeRegistry: CommunityDbRegistry | null = null

export function registerCommunityDbRegistry(registry: CommunityDbRegistry) {
  registryByQueryClient.set(registry.queryClient, registry)
  activeRegistry = registry
  return () => {
    if (registryByQueryClient.get(registry.queryClient) === registry) {
      registryByQueryClient.delete(registry.queryClient)
    }
    if (activeRegistry === registry) activeRegistry = null
  }
}

export function getCommunityDbRegistry(queryClient: QueryClient) {
  return registryByQueryClient.get(queryClient) ?? null
}

export function getActiveCommunityDbRegistry() {
  return activeRegistry
}
