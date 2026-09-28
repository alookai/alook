import {
  DbClient,
  collectionOptions,
  localOnlyCollectionOptions,
  type PendingMutation,
} from "@tanstack/react-db"
import { persistedCollectionOptions } from "@tanstack/browser-db-sqlite-persistence"
import type { PersistedCollectionPersistence } from "@tanstack/browser-db-sqlite-persistence"
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
  type MessageRow,
} from "./schema"

const INACTIVE_MESSAGE_SCOPE_LIMIT = 20
const INACTIVE_MESSAGE_LIMIT = 50

type SchemaRow<TSchema extends z.ZodType> = z.output<TSchema> & object

function canonicalCollectionOptions<
  TSchema extends z.ZodType,
  TKey extends string | number,
>(
  scopeId: string,
  name: string,
  persistence: PersistedCollectionPersistence | null,
  _schema: TSchema,
  getKey: (row: SchemaRow<TSchema>) => TKey,
) {
  const id = `community-db:${scopeId}:${name}`
  const base = { id, getKey }
  return persistence
    ? persistedCollectionOptions<SchemaRow<TSchema>, TKey>({
        ...base,
        persistence,
        schemaVersion: 1,
      })
    : localOnlyCollectionOptions<SchemaRow<TSchema>, TKey>(base)
}

export function createCommunityDbRegistry(
  queryClient: QueryClient,
  accountId: string | null,
  options: { persistence?: PersistedCollectionPersistence | null } = {},
) {
  const scopeId = accountId ?? "anon"
  const dbClient = new DbClient({ queryClient })
  const persistence = options.persistence ?? null

  const servers = dbClient.collection(collectionOptions(`community-db:${scopeId}:servers`, () => (
    canonicalCollectionOptions(scopeId, "servers", persistence, serverSchema, (row) => row.id)
  )))
  const categories = dbClient.collection(collectionOptions(`community-db:${scopeId}:categories`, () => (
    canonicalCollectionOptions(scopeId, "categories", persistence, categorySchema, (row) => row.id)
  )))
  const channels = dbClient.collection(collectionOptions(`community-db:${scopeId}:channels`, () => (
    canonicalCollectionOptions(scopeId, "channels", persistence, channelSchema, (row) => row.id)
  )))
  const serverMemberships = dbClient.collection(collectionOptions(`community-db:${scopeId}:serverMemberships`, () => (
    canonicalCollectionOptions(scopeId, "serverMemberships", persistence, serverMembershipSchema, (row) => row.id)
  )))
  const channelMemberships = dbClient.collection(collectionOptions(`community-db:${scopeId}:channelMemberships`, () => (
    canonicalCollectionOptions(scopeId, "channelMemberships", persistence, channelMembershipSchema, (row) => row.id)
  )))
  const profiles = dbClient.collection(collectionOptions(`community-db:${scopeId}:profiles`, () => (
    canonicalCollectionOptions(scopeId, "profiles", persistence, profileSchema, (row) => row.userId)
  )))
  const messages = dbClient.collection(collectionOptions(`community-db:${scopeId}:messages`, () => (
    canonicalCollectionOptions(scopeId, "messages", persistence, messageSchema, (row) => row.id)
  )))
  const readStates = dbClient.collection(collectionOptions(`community-db:${scopeId}:readStates`, () => (
    canonicalCollectionOptions(scopeId, "readStates", persistence, readStateSchema, (row) => row.channelId)
  )))
  const readStateClock = dbClient.collection(collectionOptions(`community-db:${scopeId}:readStateClock`, () => (
    canonicalCollectionOptions(scopeId, "readStateClock", persistence, readStateClockSchema, (row) => row.id)
  )))
  const attentionScopes = dbClient.collection(collectionOptions(`community-db:${scopeId}:attentionScopes`, () => (
    canonicalCollectionOptions(scopeId, "attentionScopes", persistence, attentionScopeSchema, (row) => row.scopeId)
  )))
  const attentionItems = dbClient.collection(collectionOptions(`community-db:${scopeId}:attentionItems`, () => (
    canonicalCollectionOptions(scopeId, "attentionItems", persistence, attentionItemSchema, (row) => row.id)
  )))
  const folders = dbClient.collection(collectionOptions(`community-db:${scopeId}:folders`, () => (
    canonicalCollectionOptions(scopeId, "folders", persistence, folderSchema, (row) => row.id)
  )))
  const folderItems = dbClient.collection(collectionOptions(`community-db:${scopeId}:folderItems`, () => (
    canonicalCollectionOptions(scopeId, "folderItems", persistence, folderItemSchema, (row) => row.id)
  )))
  const notificationSettings = dbClient.collection(collectionOptions(`community-db:${scopeId}:notificationSettings`, () => (
    canonicalCollectionOptions(scopeId, "notificationSettings", persistence, notificationSettingSchema, (row) => row.id)
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
  type CollectionReadiness = "not-ready" | "preloading" | "ready" | "failed"
  const collectionNames = Object.keys(collections) as CollectionName[]
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
      .then(() => collections[name].preload())
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

  const preload = async () => {
    await Promise.all(collectionNames.map(ensureCollectionReady))
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
    const transaction = dbClient.createTransaction({
      mutationFn: async ({ transaction: pending }) => {
        await collections.messages.utils.acceptMutations(pending)
      },
    })
    transaction.mutate(() => collections.messages.delete(deleteIds))
    await transaction.isPersisted.promise
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

  const clear = async () => {
    await preload()
    const mutableCollections = Object.values(collections) as unknown as Array<{
      keys: () => IterableIterator<string>
      delete: (keys: string[]) => unknown
      utils: {
        acceptMutations: (transaction: {
          mutations: Array<PendingMutation<Record<string, unknown>>>
        }) => Promise<void> | void
      }
    }>
    const transaction = dbClient.createTransaction({
      mutationFn: async ({ transaction: pending }) => {
        await Promise.all(mutableCollections.map((collection) => (
          collection.utils.acceptMutations(pending as unknown as {
            mutations: Array<PendingMutation<Record<string, unknown>>>
          })
        )))
      },
    })
    transaction.mutate(() => {
      for (const collection of mutableCollections) {
        const keys = [...collection.keys()]
        if (keys.length > 0) collection.delete(keys)
      }
    })
    await transaction.isPersisted.promise
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
    activateMessageScope,
    pruneMessageRetention,
    clear,
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
