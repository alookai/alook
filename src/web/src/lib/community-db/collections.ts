import type { z } from "zod"
import { clearPersistedCache, type QualifiedPersister } from "@/lib/query-persister"
import { disposeQueryDiagnostics } from "@/lib/observability/query-observer"
import {
  DbClient,
  BasicIndex,
  collectionOptions,
  type InferSchemaOutput,
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

  const collectionFor = <S extends z.ZodType<Record<string, unknown>, Record<string, unknown>>>(name: string, schema: S, getKey: (row: InferSchemaOutput<S>) => string) => {
    const id = `community-db-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    return dbClient.collection(collectionOptions({
      ...queryCollectionOptions<S, unknown, ReturnType<typeof collectionQueryKey>, string>({
        id, queryClient, schema, getKey,
        queryKey: collectionQueryKey(scopeId, name), queryFn: queryFnFor<InferSchemaOutput<S>>(name),
        staleTime: Infinity, gcTime: QUERY_CACHE_GC_TIME, persistedGcTime: QUERY_CACHE_GC_TIME,
      }),
      gcTime: 0,
    }))
  }
  const servers = collectionFor("servers", serverSchema, (row) => row.id)
  const categories = collectionFor("categories", categorySchema, (row) => row.id)
  const channels = collectionFor("channels", channelSchema, (row) => row.id)
  const serverMemberships = collectionFor("serverMemberships", serverMembershipSchema, (row) => row.id)
  const channelMemberships = collectionFor("channelMemberships", channelMembershipSchema, (row) => row.id)
  const profiles = collectionFor("profiles", profileSchema, (row) => row.userId)
  const messages = collectionFor("messages", messageSchema, (row) => row.id)
  const readStates = collectionFor("readStates", readStateSchema, (row) => row.channelId)
  const readStateClock = collectionFor("readStateClock", readStateClockSchema, (row) => row.id)
  const attentionScopes = collectionFor("attentionScopes", attentionScopeSchema, (row) => row.scopeId)
  const attentionItems = collectionFor("attentionItems", attentionItemSchema, (row) => row.id)
  const folders = collectionFor("folders", folderSchema, (row) => row.id)
  const folderItems = collectionFor("folderItems", folderItemSchema, (row) => row.id)
  const notificationSettings = collectionFor("notificationSettings", notificationSettingSchema, (row) => row.id)
  const friendships = collectionFor("friendships", friendshipSchema, (row) => row.id)

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
    ui: createCommunityStore(), ws: createCommunityWsStore(accountId), messageStream: createMessageStreamStore(() => ({ get: (id) => { const message = messages.get(id); return typeof message?.seq === "number" ? message as CanonicalMessage : undefined } }), queryClient),
    serverEject: createOwnerServerDeleteStore(),
    lifecycle: createStore({ active: true, generation: 0 }), transport: { send: null as ((message: object) => void) | null },
  }

  const authenticationBindings = createStore({ retireDisk: () => clearPersistedCache(accountId), retireReadingDisk: (() => Promise.resolve()) as QualifiedPersister["retireChannels"], sessionViewer: () => accountId as string | null | undefined })
  const registry = {
    accountId,
    authenticationView: createStore({ active: false, generation: 0 }),
    retireDisk: () => authenticationBindings.get().retireDisk(),
    retireReadingDisk: (ids: Iterable<string>, deleted = false) => authenticationBindings.get().retireReadingDisk(ids, deleted),
    sessionViewer: () => authenticationBindings.get().sessionViewer(),
    bindAuthentication: (sessionViewer: () => string | null | undefined, retireDisk: () => Promise<void>, retireReadingDisk: QualifiedPersister["retireChannels"] = () => Promise.resolve()) => authenticationBindings.setState(() => ({ sessionViewer, retireDisk, retireReadingDisk })),
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
      disposeQueryDiagnostics(queryClient)
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
