import {
  BasicIndex,
  BTreeIndex,
  DbClient,
  collectionOptions,
  createLiveQueryCollection,
  eq,
  type Collection,
} from "@tanstack/react-db"
import { persistedCollectionOptions } from "@tanstack/browser-db-sqlite-persistence"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
import {
  queryCollectionOptions,
  type QueryCollectionUtils,
} from "@tanstack/query-db-collection"
import { QueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import { getBrowserPersistenceRuntime } from "@/lib/browser-persistence"
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
import {
  createServersQueryFn,
  selectServersForCollection,
  serversCollectionQueryKey,
} from "./server-collection"
import {
  createServerDetailResourceQueryFn,
  selectServerDetailCategories,
  serverDetailResourceQueryKey,
} from "./server-detail-resource"
import {
  channelResourceQueryKey,
  createChannelResourceQueryFn,
  createDmsResourceQueryFn,
  dmsResourceKey,
  selectDmsChannelMemberships,
  selectDmsProfiles,
} from "./dms-resource"
import {
  createFoldersResourceQueryFn,
  foldersResourceKey,
  selectFolderItems,
  selectFolderRows,
} from "./folders-resource"
import {
  createNotificationSettingsResourceQueryFn,
  notificationSettingsResourceKey,
  selectNotificationSettingRows,
} from "./notification-settings-resource"
import {
  createReadStateResourceQueryFn,
  readStateResourceKey,
  selectReadStateClock,
  selectReadStateRows,
} from "./read-state-resource"
import {
  createMessageCollectionDescriptor,
  readMessageWindowPublication,
  type MessageCollectionDemand,
} from "./message-resource"
import { createServerMembersCollectionDescriptor } from "./server-members-resource"
import {
  accountAttentionResourceKey,
  createAccountAttentionResourceQueryFn,
  selectAttentionItems,
  selectAttentionScopes,
} from "./account-attention-resource"

const INACTIVE_MESSAGE_SCOPE_LIMIT = 20
const INACTIVE_MESSAGE_LIMIT = 50

export function createCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: {
    persistence?: PersistedCollectionPersistence | null
    serverTransport?: boolean
  } = {},
) {
  const scopeId = accountId ?? "anon"
  const dbClient = new DbClient({ queryClient })
  const persistence = options.persistence ?? null
  let readServerRows = (): Iterable<ServerRow> => []
  const serverCollectionId = `community-db:${scopeId}:servers`
  const baseServerQueryFn = createServersQueryFn(queryClient)
  const selectServerRows = (response: Awaited<ReturnType<typeof baseServerQueryFn>>) => (
    selectServersForCollection(response, readServerRows())
  )
  const serverQueryOptions = queryCollectionOptions({
    id: serverCollectionId,
    queryClient,
    queryKey: serversCollectionQueryKey(),
    queryFn: baseServerQueryFn,
    select: selectServerRows,
    schema: serverSchema,
    getKey: (row) => row.id,
    enabled: options.serverTransport === true,
    initialData: options.serverTransport === true
      ? undefined
      : { servers: [], unreadSources: [] },
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const baseServerOptions = persistence
    ? persistedCollectionOptions({
        ...serverQueryOptions,
        persistence,
        schemaVersion: 1,
      })
    : serverQueryOptions
  const serverOptions = baseServerOptions
  const servers = dbClient.collection(collectionOptions(`community-db:${scopeId}:servers`, () => (
    { ...serverOptions, schema: serverSchema }
  )) as never) as unknown as Collection<
    ServerRow,
    string,
    QueryCollectionUtils<ServerRow, string>,
    typeof serverSchema,
    z.input<typeof serverSchema>
  >
  readServerRows = () => servers.values()
  const serverDetailQueryFn = createServerDetailResourceQueryFn(queryClient, scopeId)
  const categoryQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:categories`,
    queryClient,
    queryKey: (loadOptions) => serverDetailResourceQueryKey(scopeId, loadOptions),
    queryFn: serverDetailQueryFn,
    select: selectServerDetailCategories,
    schema: categorySchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const categoryOptions = persistence
    ? persistedCollectionOptions({
        ...categoryQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : categoryQueryOptions
  const categories = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:categories`,
    () => ({ ...categoryOptions, schema: categorySchema } as never),
  )) as unknown as Collection<
    CategoryRow,
    string,
    QueryCollectionUtils<CategoryRow, string>,
    typeof categorySchema,
    z.input<typeof categorySchema>
  >
  const channelQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:channels`,
    queryClient,
    queryKey: (loadOptions) => channelResourceQueryKey(scopeId, loadOptions),
    queryFn: createChannelResourceQueryFn(queryClient, scopeId),
    select: (resource) => resource?.channels ?? [],
    schema: channelSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const channelOptions = persistence
    ? persistedCollectionOptions({
        ...channelQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : channelQueryOptions
  const channels = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:channels`,
    () => ({ ...channelOptions, schema: channelSchema } as never),
  )) as unknown as Collection<
    ChannelRow,
    string,
    QueryCollectionUtils<ChannelRow, string>,
    typeof channelSchema,
    z.input<typeof channelSchema>
  >
  const serverMembersDescriptor = createServerMembersCollectionDescriptor(queryClient, scopeId)
  const serverMembershipQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:serverMemberships`,
    queryClient,
    queryKey: serverMembersDescriptor.queryKey,
    queryFn: serverMembersDescriptor.queryFn,
    schema: serverMembershipSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const serverMembershipOptions = persistence
    ? persistedCollectionOptions({
        ...serverMembershipQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : serverMembershipQueryOptions
  const serverMemberships = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:serverMemberships`,
    () => ({ ...serverMembershipOptions, schema: serverMembershipSchema } as never),
  )) as unknown as Collection<
    ServerMembershipRow,
    string,
    QueryCollectionUtils<ServerMembershipRow, string>,
    typeof serverMembershipSchema,
    z.input<typeof serverMembershipSchema>
  >
  serverMemberships.createIndex((row) => row.id, { indexType: BTreeIndex })
  serverMembersDescriptor.bindRows(() => serverMemberships.values())
  const dmsQueryFn = createDmsResourceQueryFn(queryClient, scopeId)
  const channelMembershipQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:channelMemberships`,
    queryClient,
    queryKey: dmsResourceKey(scopeId),
    queryFn: dmsQueryFn,
    select: selectDmsChannelMemberships,
    schema: channelMembershipSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const channelMembershipOptions = persistence
    ? persistedCollectionOptions({
        ...channelMembershipQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : channelMembershipQueryOptions
  const channelMemberships = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:channelMemberships`,
    () => ({ ...channelMembershipOptions, schema: channelMembershipSchema } as never),
  )) as unknown as Collection<
    ChannelMembershipRow,
    string,
    QueryCollectionUtils<ChannelMembershipRow, string>,
    typeof channelMembershipSchema,
    z.input<typeof channelMembershipSchema>
  >
  const profileQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:profiles`,
    queryClient,
    queryKey: dmsResourceKey(scopeId),
    queryFn: dmsQueryFn,
    select: selectDmsProfiles,
    schema: profileSchema,
    getKey: (row) => row.userId,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const profileOptions = persistence
    ? persistedCollectionOptions({
        ...profileQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : profileQueryOptions
  const profiles = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:profiles`,
    () => ({ ...profileOptions, schema: profileSchema } as never),
  )) as unknown as Collection<
    ProfileRow,
    string,
    QueryCollectionUtils<ProfileRow, string>,
    typeof profileSchema,
    z.input<typeof profileSchema>
  >
  const messageDescriptor = createMessageCollectionDescriptor(queryClient, scopeId)
  const messageQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:messages`,
    queryClient,
    queryKey: messageDescriptor.queryKey,
    queryFn: messageDescriptor.queryFn,
    schema: messageSchema,
    getKey: (row) => row.id,
    syncMode: "on-demand",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const messageOptions = persistence
    ? persistedCollectionOptions({
        ...messageQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : messageQueryOptions
  const messages = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:messages`,
    () => ({ ...messageOptions, schema: messageSchema } as never),
  )) as unknown as Collection<
    MessageRow,
    string,
    QueryCollectionUtils<MessageRow, string>,
    typeof messageSchema,
    z.input<typeof messageSchema>
  >
  messageDescriptor.bindRows(() => messages.values())
  messages.createIndex((row) => row.channelId, { indexType: BasicIndex })
  messages.createIndex((row) => row.seq!, { indexType: BTreeIndex })
  const readStateQueryFn = createReadStateResourceQueryFn(queryClient, scopeId)
  const readStateQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:readStates`,
    queryClient,
    queryKey: readStateResourceKey(scopeId),
    queryFn: readStateQueryFn,
    select: selectReadStateRows,
    schema: readStateSchema,
    getKey: (row) => row.channelId,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const readStateOptions = persistence
    ? persistedCollectionOptions({ ...readStateQueryOptions, persistence, schemaVersion: 2 })
    : readStateQueryOptions
  const readStates = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:readStates`,
    () => ({ ...readStateOptions, schema: readStateSchema } as never),
  )) as unknown as Collection<
    ReadStateRow,
    string,
    QueryCollectionUtils<ReadStateRow, string>,
    typeof readStateSchema,
    z.input<typeof readStateSchema>
  >
  const readStateClockQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:readStateClock`,
    queryClient,
    queryKey: readStateResourceKey(scopeId),
    queryFn: readStateQueryFn,
    select: selectReadStateClock,
    schema: readStateClockSchema,
    getKey: (row) => row.id,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const readStateClockOptions = persistence
    ? persistedCollectionOptions({ ...readStateClockQueryOptions, persistence, schemaVersion: 2 })
    : readStateClockQueryOptions
  const readStateClock = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:readStateClock`,
    () => ({ ...readStateClockOptions, schema: readStateClockSchema } as never),
  )) as unknown as Collection<
    ReadStateClockRow,
    string,
    QueryCollectionUtils<ReadStateClockRow, string>,
    typeof readStateClockSchema,
    z.input<typeof readStateClockSchema>
  >
  const accountAttentionQueryFn = createAccountAttentionResourceQueryFn(
    queryClient,
    () => messages.values(),
  )
  const attentionScopeQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:attentionScopes`,
    queryClient,
    queryKey: accountAttentionResourceKey(),
    queryFn: accountAttentionQueryFn,
    select: selectAttentionScopes,
    schema: attentionScopeSchema,
    getKey: (row) => row.scopeId,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const attentionScopeOptions = persistence
    ? persistedCollectionOptions({
        ...attentionScopeQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : attentionScopeQueryOptions
  const attentionScopes = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:attentionScopes`,
    () => ({ ...attentionScopeOptions, schema: attentionScopeSchema } as never),
  )) as unknown as Collection<
    AttentionScopeRow,
    string,
    QueryCollectionUtils<AttentionScopeRow, string>,
    typeof attentionScopeSchema,
    z.input<typeof attentionScopeSchema>
  >
  const attentionItemQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:attentionItems`,
    queryClient,
    queryKey: accountAttentionResourceKey(),
    queryFn: accountAttentionQueryFn,
    select: selectAttentionItems,
    schema: attentionItemSchema,
    getKey: (row) => row.id,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: false,
  })
  const attentionItemOptions = persistence
    ? persistedCollectionOptions({
        ...attentionItemQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : attentionItemQueryOptions
  const attentionItems = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:attentionItems`,
    () => ({ ...attentionItemOptions, schema: attentionItemSchema } as never),
  )) as unknown as Collection<
    AttentionItemRow,
    string,
    QueryCollectionUtils<AttentionItemRow, string>,
    typeof attentionItemSchema,
    z.input<typeof attentionItemSchema>
  >
  const foldersQueryFn = createFoldersResourceQueryFn(queryClient, scopeId)
  const folderQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:folders`,
    queryClient,
    queryKey: foldersResourceKey(scopeId),
    queryFn: foldersQueryFn,
    select: selectFolderRows,
    schema: folderSchema,
    getKey: (row) => row.id,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const folderOptions = persistence
    ? persistedCollectionOptions({ ...folderQueryOptions, persistence, schemaVersion: 2 })
    : folderQueryOptions
  const folders = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:folders`,
    () => ({ ...folderOptions, schema: folderSchema } as never),
  )) as unknown as Collection<
    FolderRow,
    string,
    QueryCollectionUtils<FolderRow, string>,
    typeof folderSchema,
    z.input<typeof folderSchema>
  >
  const folderItemQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:folderItems`,
    queryClient,
    queryKey: foldersResourceKey(scopeId),
    queryFn: foldersQueryFn,
    select: selectFolderItems,
    schema: folderItemSchema,
    getKey: (row) => row.id,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const folderItemOptions = persistence
    ? persistedCollectionOptions({ ...folderItemQueryOptions, persistence, schemaVersion: 2 })
    : folderItemQueryOptions
  const folderItems = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:folderItems`,
    () => ({ ...folderItemOptions, schema: folderItemSchema } as never),
  )) as unknown as Collection<
    FolderItemRow,
    string,
    QueryCollectionUtils<FolderItemRow, string>,
    typeof folderItemSchema,
    z.input<typeof folderItemSchema>
  >
  const notificationSettingQueryOptions = queryCollectionOptions({
    id: `community-db:${scopeId}:notificationSettings`,
    queryClient,
    queryKey: notificationSettingsResourceKey(scopeId),
    queryFn: createNotificationSettingsResourceQueryFn(queryClient, scopeId),
    select: selectNotificationSettingRows,
    schema: notificationSettingSchema,
    getKey: (row) => row.id,
    syncMode: "eager",
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  const notificationSettingOptions = persistence
    ? persistedCollectionOptions({
        ...notificationSettingQueryOptions,
        persistence,
        schemaVersion: 2,
      })
    : notificationSettingQueryOptions
  const notificationSettings = dbClient.collection(collectionOptions(
    `community-db:${scopeId}:notificationSettings`,
    () => ({ ...notificationSettingOptions, schema: notificationSettingSchema } as never),
  )) as unknown as Collection<
    NotificationSettingRow,
    string,
    QueryCollectionUtils<NotificationSettingRow, string>,
    typeof notificationSettingSchema,
    z.input<typeof notificationSettingSchema>
  >

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
  type CollectionReadiness = "not-ready" | "preloading" | "ready" | "failed"
  const collectionNames = Object.keys(collections) as CollectionName[]
  const onDemandCollectionNames = new Set<CollectionName>([
    "categories",
    "channels",
    "serverMemberships",
    "channelMemberships",
    "profiles",
    "messages",
  ])
  const collectionReadiness = new Map<CollectionName, CollectionReadiness>(
    collectionNames.map((name) => [name, "not-ready"]),
  )
  const collectionPreloads = new Map<CollectionName, Promise<void>>()
  const collectionReadinessListeners = new Set<() => void>()
  const restoredCollectionNames = new Set<CollectionName>()
  const restoredCollectionListeners = new Set<() => void>()
  let restoredDataExists = false
  let readinessVersion = 0
  let generationFailure: unknown = null
  const activeMessageScopes = new Map<string, number>()
  const inactiveMessageScopes = new Map<string, number>()
  let messageScopeClock = 0
  let retentionScheduled = false
  let serverRefetch: Promise<void> | null = null

  const serverRestoreSubscription = persistence
    ? servers.subscribeChanges(() => {
        if (
          servers.size === 0
          || queryClient.getQueryState(serversCollectionQueryKey())?.status === "success"
          || restoredCollectionNames.has("servers")
        ) return
        restoredCollectionNames.add("servers")
        restoredDataExists = true
        for (const listener of restoredCollectionListeners) listener()
      }, { includeInitialState: true })
    : null

  const publishReadiness = () => {
    readinessVersion += 1
    for (const listener of collectionReadinessListeners) listener()
  }

  const failGeneration = (error: unknown) => {
    if (generationFailure !== null) return
    generationFailure = error
    for (const name of collectionNames) collectionReadiness.set(name, "failed")
    publishReadiness()
  }

  const ensureCollectionReady = (name: CollectionName): Promise<void> => {
    if (generationFailure !== null) return Promise.reject(generationFailure)
    const existing = collectionPreloads.get(name)
    if (existing) return existing

    collectionReadiness.set(name, "preloading")
    publishReadiness()
    const promise = Promise.resolve()
      .then(() => onDemandCollectionNames.has(name) ? undefined : collections[name].preload())
      .then(() => {
        if (generationFailure !== null) throw generationFailure
        const restored = collections[name].size > 0
        if (restored) {
          restoredCollectionNames.add(name)
          restoredDataExists = true
        }
        collectionReadiness.set(name, "ready")
        publishReadiness()
        if (restored) {
          for (const listener of restoredCollectionListeners) listener()
        }
      })
      .catch((error) => {
        failGeneration(error)
        throw error
      })
    collectionPreloads.set(name, promise)
    return promise
  }

  const preloadAccountChannelResource = async () => {
    await queryClient.ensureQueryData({
      queryKey: dmsResourceKey(scopeId),
      queryFn: dmsQueryFn,
      staleTime: Infinity,
    })
  }

  const preload = async () => {
    await Promise.all([
      ...collectionNames.map(ensureCollectionReady),
      preloadAccountChannelResource(),
    ])
    const scopesByNewest = new Map<string, number>()
    for (const message of collections.messages.values()) {
      const order = Date.parse(message.createdAt ?? "") || message.seq || 0
      scopesByNewest.set(message.channelId, Math.max(scopesByNewest.get(message.channelId) ?? 0, order))
    }
    for (const [scopeId] of [...scopesByNewest].sort((a, b) => a[1] - b[1])) {
      if (!activeMessageScopes.has(scopeId) && !inactiveMessageScopes.has(scopeId)) {
        messageScopeClock += 1
        inactiveMessageScopes.set(scopeId, messageScopeClock)
      }
    }
  }

  const requestServerRefetch = () => {
    serverRefetch ??= ensureCollectionReady("servers")
      .then(() => servers.utils.refetch({ throwOnError: true }))
      .then(() => undefined)
      .finally(() => {
        serverRefetch = null
      })
    return serverRefetch
  }

  const pruneMessageRetention = async () => {
    await preload()
    const retainedInactiveScopes = new Set(
      [...inactiveMessageScopes]
        .sort((a, b) => b[1] - a[1])
        .slice(0, INACTIVE_MESSAGE_SCOPE_LIMIT)
        .map(([scopeId]) => scopeId),
    )
    const attentionMessageIds = new Set(
      [...collections.attentionItems.values()].flatMap((item) => (
        item.messageId ? [item.messageId] : []
      )),
    )
    const messagesByScope = new Map<string, MessageRow[]>()
    for (const message of collections.messages.values()) {
      const rows = messagesByScope.get(message.channelId) ?? []
      rows.push(message)
      messagesByScope.set(message.channelId, rows)
    }
    const retainedMessageIds = new Set(attentionMessageIds)
    for (const [scopeId, rows] of messagesByScope) {
      if (activeMessageScopes.has(scopeId)) {
        for (const row of rows) retainedMessageIds.add(row.id)
        continue
      }
      if (!retainedInactiveScopes.has(scopeId)) continue
      rows.sort((a, b) => (
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
        || (b.seq ?? 0) - (a.seq ?? 0)
        || b.id.localeCompare(a.id)
      ))
      for (const row of rows.slice(0, INACTIVE_MESSAGE_LIMIT)) {
        retainedMessageIds.add(row.id)
      }
    }
    const deleteIds = [...collections.messages.keys()].filter(
      (messageId) => !retainedMessageIds.has(messageId),
    )
    if (deleteIds.length === 0) return
    collections.messages.utils.writeDelete(deleteIds)
  }

  const activateMessageScope = (scopeId: string) => {
    activeMessageScopes.set(scopeId, (activeMessageScopes.get(scopeId) ?? 0) + 1)
    inactiveMessageScopes.delete(scopeId)
    return () => {
      const remaining = (activeMessageScopes.get(scopeId) ?? 1) - 1
      if (remaining > 0) {
        activeMessageScopes.set(scopeId, remaining)
        return
      }
      activeMessageScopes.delete(scopeId)
      messageScopeClock += 1
      inactiveMessageScopes.set(scopeId, messageScopeClock)
      if (retentionScheduled) return
      retentionScheduled = true
      queueMicrotask(() => {
        retentionScheduled = false
        void pruneMessageRetention().catch(() => {})
      })
    }
  }

  const preloadMessageWindow = async (
    demand: MessageCollectionDemand,
    limit: number,
    signal?: AbortSignal,
  ) => {
    messageDescriptor.setDemand(demand)
    const lease = messageDescriptor.acquireWindow(demand, limit)
    const view = createLiveQueryCollection({
      query: (q) => q.from({ message: messages })
        .where(({ message }) => eq(message.channelId, demand.scope.channelId))
        .orderBy(
          ({ message }) => message.seq,
          demand.sequence.direction === "older" ? "desc" : "asc",
        )
        .orderBy(
          ({ message }) => message.id,
          demand.sequence.direction === "older" ? "desc" : "asc",
        )
        .limit(demand.sequence.base.mode === "anchor" ? 26 : 50),
    })
    let released = false
    const release = async () => {
      if (released) return
      released = true
      signal?.removeEventListener("abort", onAbort)
      await view.cleanup()
      await lease.release()
    }
    let rejectAbort: ((error: Error) => void) | undefined
    const abort = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const onAbort = () => {
      const error = new Error("Message window acquisition aborted")
      error.name = "AbortError"
      rejectAbort?.(error)
      void release()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener("abort", onAbort, { once: true })
    try {
      await (signal ? Promise.race([view.preload(), abort]) : view.preload())
      const publication = readMessageWindowPublication(queryClient, demand)
      if (!publication) throw new Error("Message window completed without publication")
      return { publication, release }
    } catch (error) {
      await release()
      throw error
    }
  }

  const clear = async () => {
    await preload()
    const queryCollections = Object.values(collections) as unknown as Array<{
      keys: () => IterableIterator<string>
      utils: { writeDelete: (keys: string[]) => void }
    }>
    for (const collection of queryCollections) {
      const keys = [...collection.keys()]
      if (keys.length > 0) collection.utils.writeDelete(keys)
    }
  }

  return {
    accountId,
    scopeId,
    queryClient,
    dbClient,
    collections,
    ensureCollectionReady,
    isCollectionReady: (name: CollectionName) => collectionReadiness.get(name) === "ready",
    getCollectionReadiness: (name: CollectionName) => collectionReadiness.get(name)!,
    getCollectionReadinessSnapshot: () => readinessVersion,
    subscribeCollectionReadiness: (listener: () => void) => {
      collectionReadinessListeners.add(listener)
      return () => collectionReadinessListeners.delete(listener)
    },
    isFailed: () => generationFailure !== null,
    assertGenerationActive: () => {
      if (generationFailure !== null) throw generationFailure
    },
    captureRestoredCollections: () => {
      // Compatibility for callers that used the former aggregate preload gate.
      // Restored ownership is now captured inside each collection's readiness
      // promise before that promise can release queued canonical writes.
    },
    hasRestoredCollection: (name: CollectionName) => restoredCollectionNames.has(name),
    hasRestoredData: () => restoredDataExists,
    subscribeRestoredCollections: (listener: () => void) => {
      restoredCollectionListeners.add(listener)
      return () => restoredCollectionListeners.delete(listener)
    },
    preload,
    requestServerRefetch,
    accountAttentionQueryFn,
    waitForServerRefetch: () => serverRefetch ?? Promise.resolve(),
    activateMessageScope,
    acquireMessageWindow: messageDescriptor.acquireWindow,
    acquireServerMembers: serverMembersDescriptor.acquire,
    adjustServerMembersTotal: serverMembersDescriptor.adjustTotal,
    preloadMessageWindow,
    purgeMessageScope: messageDescriptor.purgeScope,
    reconcileMessageScope: messageDescriptor.reconcileScope,
    markMessageChanged: messageDescriptor.markChanged,
    resetMessageDemand: messageDescriptor.resetDemand,
    reconcileServerMembers: serverMembersDescriptor.reconcile,
    markServerMembershipChanged: serverMembersDescriptor.markChanged,
    setMessageDemand: messageDescriptor.setDemand,
    pruneMessageRetention,
    clear,
    cleanup: async () => {
      serverRestoreSubscription?.unsubscribe()
      await dbClient.cleanup()
    },
  }
}

export type CommunityDbRegistry = ReturnType<typeof createCommunityDbRegistry>

const registryByQueryClient = new WeakMap<QueryClient, CommunityDbRegistry>()
export type CommunityDbRegistryBinding = {
  registry: CommunityDbRegistry
  generation: number
}

type CommunityDbRegistryBindingState = {
  generation: number
  current: CommunityDbRegistryBinding | null
  listeners: Set<() => void>
}

const registryBindingStates = new WeakMap<QueryClient, CommunityDbRegistryBindingState>()
let activeRegistry: CommunityDbRegistry | null = null

function registryBindingState(queryClient: QueryClient) {
  let state = registryBindingStates.get(queryClient)
  if (!state) {
    state = { generation: 0, current: null, listeners: new Set() }
    registryBindingStates.set(queryClient, state)
  }
  return state
}

function publishRegistryBinding(state: CommunityDbRegistryBindingState) {
  for (const listener of state.listeners) listener()
}

export function registerCommunityDbRegistry(registry: CommunityDbRegistry) {
  const state = registryBindingState(registry.queryClient)
  const binding = { registry, generation: state.generation + 1 }
  state.generation = binding.generation
  state.current = binding
  registryByQueryClient.set(registry.queryClient, registry)
  activeRegistry = registry
  publishRegistryBinding(state)
  return () => {
    const current = state.current === binding
    if (current) {
      state.current = null
      registryByQueryClient.delete(registry.queryClient)
      publishRegistryBinding(state)
    }
    if (current && activeRegistry === registry) activeRegistry = null
  }
}

export function getCommunityDbRegistry(queryClient: QueryClient) {
  return registryByQueryClient.get(queryClient) ?? null
}

export function applyCommunityServerPatch(
  queryClient: QueryClient,
  serverId: string,
  changes: Record<string, unknown>,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  const supported = Object.entries(changes).every(([field, value]) => {
    if (field === "name" || field === "description") return typeof value === "string"
    if (field === "icon") return value === null || typeof value === "string"
    return false
  })
  if (
    !registry.isCollectionReady("servers")
    || !registry.collections.servers.has(serverId)
    || !supported
  ) {
    void registry.requestServerRefetch().catch(() => {})
    return false
  }
  registry.collections.servers.utils.writeUpdate({ id: serverId, ...changes })
  return true
}

export function deleteCommunityServerRow(
  registry: CommunityDbRegistry,
  serverId: string,
) {
  if (!registry.collections.servers.has(serverId)) return false
  registry.collections.servers.utils.writeDelete(serverId)
  return true
}

export function getCommunityDbRegistryBinding(queryClient: QueryClient) {
  return registryBindingState(queryClient).current
}

export function isCommunityDbRegistryBindingCurrent(
  queryClient: QueryClient,
  binding: CommunityDbRegistryBinding,
) {
  return registryBindingState(queryClient).current === binding
}

export function subscribeCommunityDbRegistryBinding(
  queryClient: QueryClient,
  listener: () => void,
) {
  const state = registryBindingState(queryClient)
  state.listeners.add(listener)
  return () => state.listeners.delete(listener)
}

export function getActiveCommunityDbRegistry() {
  return activeRegistry
}

export async function clearCommunityPersistenceForAccount(accountId: string) {
  if (activeRegistry?.accountId === accountId) {
    await activeRegistry.clear()
    return
  }
  const runtime = await getBrowserPersistenceRuntime()
  if (!runtime.persistence) return
  const queryClient = new QueryClient()
  const registry = createCommunityDbRegistry(queryClient, accountId, {
    persistence: runtime.persistence,
  })
  try {
    await registry.clear()
  } finally {
    registry.cleanup()
    queryClient.clear()
  }
}
