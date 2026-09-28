import {
  createCollection,
  createTransaction,
  localOnlyCollectionOptions,
  type PendingMutation,
} from "@tanstack/react-db"
import {
  persistedCollectionOptions,
  type PersistedCollectionPersistence,
} from "@tanstack/browser-db-sqlite-persistence"
import type { Artifact, Message } from "@alook/shared"
import {
  getBrowserPersistenceRuntime,
  registerPersistenceClearScope,
} from "./browser-persistence"

export interface CacheMeta {
  conversation_id: string
  lastFetchedAt: number
  lastAccessedAt: number
  messageCount: number
  newestMessageId: string | null
  hasMore: boolean
  serverMessageCount: number
}

export interface LastOpenEntry {
  key: string
  conversation_id: string
  newestMessageId: string | null
  serverMessageCount: number
  updatedAt: number
}

export interface ConvExtrasEntry {
  conversation_id: string
  artifacts: Artifact[]
  conversation_type: string
  conversation_title: string
  conversation_channel: string
  conversation_created_at: string
  hasMoreArtifacts: boolean
  updatedAt: number
}

const MAX_CONVERSATIONS = 50
const MESSAGE_KEY_SEPARATOR = "\u0000"

type AcceptingCollection = {
  keys: () => IterableIterator<string>
  delete: (keys: string | string[]) => unknown
  utils: {
    acceptMutations: (transaction: {
      mutations: Array<PendingMutation<Record<string, unknown>>>
    }) => Promise<void> | void
  }
}

function collectionOptions<T extends object>(
  id: string,
  persistence: PersistedCollectionPersistence | null,
  getKey: (row: T) => string,
) {
  return persistence
    ? persistedCollectionOptions<T, string>({
        id,
        getKey,
        persistence,
        schemaVersion: 1,
      })
    : localOnlyCollectionOptions<T, string>({ id, getKey })
}

function messageKey(conversationId: string, messageId: string) {
  return `${conversationId}${MESSAGE_KEY_SEPARATOR}${messageId}`
}

function lastOpenKey(agentId: string, channel: string | null | undefined) {
  return `${agentId}::${channel ?? ""}`
}

function plainRow<T extends object>(row: T): T {
  const {
    $collectionId: _collectionId,
    $key: _key,
    $origin: _origin,
    $synced: _synced,
    ...plain
  } = row as T & {
    $collectionId?: unknown
    $key?: unknown
    $origin?: unknown
    $synced?: unknown
  }
  return plain as T
}

function createRegistry(
  workspaceId: string,
  persistence: PersistedCollectionPersistence | null,
) {
  const prefix = `agent-chat:${workspaceId}`
  const messages = createCollection(collectionOptions<Message>(
    `${prefix}:messages`,
    persistence,
    (row) => messageKey(row.conversation_id, row.id),
  ))
  const metas = createCollection(collectionOptions<CacheMeta>(
    `${prefix}:metas`,
    persistence,
    (row) => row.conversation_id,
  ))
  const lastOpen = createCollection(collectionOptions<LastOpenEntry>(
    `${prefix}:last-open`,
    persistence,
    (row) => row.key,
  ))
  const extras = createCollection(collectionOptions<ConvExtrasEntry>(
    `${prefix}:extras`,
    persistence,
    (row) => row.conversation_id,
  ))
  const collections = { messages, metas, lastOpen, extras }

  const preload = async () => {
    await Promise.all(Object.values(collections).map((collection) => collection.preload()))
  }
  const clear = async () => {
    await preload()
    await mutateCollections(Object.values(collections), () => {
      for (const collection of Object.values(collections)) {
        const keys = [...collection.keys()]
        if (keys.length > 0) collection.delete(keys)
      }
    })
  }
  return {
    workspaceId,
    collections,
    preload,
    clear,
    cleanup: () => Object.values(collections).forEach((collection) => collection.cleanup()),
  }
}

type AgentChatRegistry = ReturnType<typeof createRegistry>
const registries = new Map<string, Promise<AgentChatRegistry>>()
let activeWorkspaceId: string | null = null

async function buildRegistry(workspaceId: string): Promise<AgentChatRegistry> {
  const runtime = await getBrowserPersistenceRuntime()
  let registry = createRegistry(workspaceId, runtime.persistence)
  try {
    await registry.preload()
  } catch (error) {
    registry.cleanup()
    console.warn("[Alook persistence] Agent cache preload failed; using memory only", error)
    registry = createRegistry(workspaceId, null)
    await registry.preload()
  }
  const unregisterClear = registerPersistenceClearScope(`agent:${workspaceId}`, registry.clear)
  const cleanup = registry.cleanup
  registry.cleanup = () => {
    unregisterClear()
    cleanup()
  }
  return registry
}

function registryFor(workspaceId?: string): Promise<AgentChatRegistry> | null {
  const resolvedId = workspaceId ?? activeWorkspaceId
  if (!resolvedId) return null
  activeWorkspaceId = resolvedId
  let registry = registries.get(resolvedId)
  if (!registry) {
    registry = buildRegistry(resolvedId)
    registries.set(resolvedId, registry)
  }
  return registry
}

export function openAgentChatPersistence(workspaceId: string): Promise<void> {
  return registryFor(workspaceId)!.then(() => undefined)
}

async function mutateCollections(
  collections: Array<AcceptingCollection>,
  mutate: () => void,
) {
  const transaction = createTransaction({
    mutationFn: async ({ transaction: pending }) => {
      await Promise.all(collections.map((collection) => (
        collection.utils.acceptMutations(pending as unknown as {
          mutations: Array<PendingMutation<Record<string, unknown>>>
        })
      )))
    },
  })
  transaction.mutate(mutate)
  await transaction.isPersisted.promise
}

function upsert<T extends object>(
  collection: {
    has: (key: string) => boolean
    insert: (row: T) => unknown
    update: (key: string, callback: (draft: T) => void) => unknown
  },
  key: string,
  row: T,
) {
  if (!collection.has(key)) {
    collection.insert(row)
    return
  }
  collection.update(key, (draft) => Object.assign(draft, row))
}

function sortedMessages(registry: AgentChatRegistry, conversationId: string) {
  return [...registry.collections.messages.values()]
    .filter((message) => (
      message.conversation_id === conversationId && !message.id.startsWith("temp-")
    ))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((message) => plainRow<Message>(message))
}

export async function getCachedMessages(
  conversationId: string,
  workspaceId?: string,
): Promise<Message[] | null> {
  const pending = registryFor(workspaceId)
  if (!pending) return null
  try {
    const registry = await pending
    const messages = sortedMessages(registry, conversationId)
    if (messages.length === 0) return null
    const meta = registry.collections.metas.get(conversationId)
    if (meta) {
      await mutateCollections([registry.collections.metas], () => {
        registry.collections.metas.update(conversationId, (draft) => {
          draft.lastAccessedAt = Date.now()
        })
      })
    }
    return messages
  } catch {
    return null
  }
}

export async function getCachedMessagesBefore(
  conversationId: string,
  beforeCreatedAt: string,
  beforeId: string,
  limit: number,
  workspaceId?: string,
): Promise<{ messages: Message[]; hasMore: boolean } | null> {
  const pending = registryFor(workspaceId)
  if (!pending) return null
  try {
    const registry = await pending
    const meta = registry.collections.metas.get(conversationId)
    if (!meta) return null
    const before = sortedMessages(registry, conversationId).filter((message) => (
      message.created_at < beforeCreatedAt
      || (message.created_at === beforeCreatedAt && message.id < beforeId)
    ))
    const newestFirst = before.slice().reverse()
    const selected = newestFirst.slice(0, limit).reverse()
    if (selected.length < limit && meta.hasMore) return null
    await mutateCollections([registry.collections.metas], () => {
      registry.collections.metas.update(conversationId, (draft) => {
        draft.lastAccessedAt = Date.now()
      })
    })
    return { messages: selected, hasMore: newestFirst.length > limit || meta.hasMore }
  } catch {
    return null
  }
}

export async function mergeCachedMessages(
  conversationId: string,
  messages: Message[],
  hasMore: boolean | null,
  workspaceId?: string,
  serverMessageCount?: number,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  const valid = messages.filter((message) => !message.id.startsWith("temp-"))
  if (valid.length === 0) return
  try {
    const registry = await pending
    const current = sortedMessages(registry, conversationId)
    const merged = new Map<string, Message>(current.map((message) => [message.id, message]))
    for (const message of valid) merged.set(message.id, message)
    const allMessages = [...merged.values()]
    const newest = allMessages.reduce((a, b) => (
      a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id) ? a : b
    ))
    const existingMeta = registry.collections.metas.get(conversationId)
    const now = Date.now()
    const meta: CacheMeta = {
      conversation_id: conversationId,
      lastFetchedAt: now,
      lastAccessedAt: now,
      messageCount: allMessages.length,
      newestMessageId: newest.id,
      hasMore: hasMore ?? existingMeta?.hasMore ?? true,
      serverMessageCount: serverMessageCount ?? existingMeta?.serverMessageCount ?? 0,
    }
    await mutateCollections(
      [registry.collections.messages, registry.collections.metas],
      () => {
        for (const message of valid) {
          upsert(
            registry.collections.messages,
            messageKey(conversationId, message.id),
            message,
          )
        }
        upsert(registry.collections.metas, conversationId, meta)
      },
    )
    void evictLRU(MAX_CONVERSATIONS, workspaceId)
  } catch {
    // Cache writes never block the server-backed chat path.
  }
}

export async function appendCachedMessage(
  conversationId: string,
  message: Message,
  workspaceId?: string,
): Promise<void> {
  if (message.id.startsWith("temp-")) return
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    const meta = registry.collections.metas.get(conversationId)
    if (!meta) return
    const key = messageKey(conversationId, message.id)
    const exists = registry.collections.messages.has(key)
    await mutateCollections(
      [registry.collections.messages, registry.collections.metas],
      () => {
        upsert(registry.collections.messages, key, message)
        registry.collections.metas.update(conversationId, (draft) => {
          draft.lastAccessedAt = Date.now()
          draft.messageCount += exists ? 0 : 1
          draft.newestMessageId = message.id
        })
      },
    )
  } catch {}
}

export async function getCacheMeta(
  conversationId: string,
  workspaceId?: string,
): Promise<CacheMeta | null> {
  const pending = registryFor(workspaceId)
  if (!pending) return null
  try {
    const row = (await pending).collections.metas.get(conversationId)
    return row ? plainRow<CacheMeta>(row) : null
  } catch {
    return null
  }
}

export async function getLastOpenConversation(
  agentId: string,
  channel: string | null | undefined,
  workspaceId?: string,
): Promise<LastOpenEntry | null> {
  const pending = registryFor(workspaceId)
  if (!pending) return null
  try {
    const row = (await pending).collections.lastOpen.get(lastOpenKey(agentId, channel))
    return row ? plainRow<LastOpenEntry>(row) : null
  } catch {
    return null
  }
}

export async function setLastOpenConversation(
  agentId: string,
  channel: string | null | undefined,
  entry: Pick<LastOpenEntry, "conversation_id" | "newestMessageId" | "serverMessageCount">,
  workspaceId?: string,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    const key = lastOpenKey(agentId, channel)
    await mutateCollections([registry.collections.lastOpen], () => {
      upsert(registry.collections.lastOpen, key, { key, ...entry, updatedAt: Date.now() })
    })
  } catch {}
}

export async function clearLastOpenForConversation(
  conversationId: string,
  workspaceId?: string,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    const keys = [...registry.collections.lastOpen.values()]
      .filter((row) => row.conversation_id === conversationId)
      .map((row) => row.key)
    if (keys.length === 0) return
    await mutateCollections([registry.collections.lastOpen], () => {
      registry.collections.lastOpen.delete(keys)
    })
  } catch {}
}

export async function getConvExtras(
  conversationId: string,
  workspaceId?: string,
): Promise<ConvExtrasEntry | null> {
  const pending = registryFor(workspaceId)
  if (!pending) return null
  try {
    const row = (await pending).collections.extras.get(conversationId)
    return row ? plainRow<ConvExtrasEntry>(row) : null
  } catch {
    return null
  }
}

export async function setConvExtras(
  conversationId: string,
  entry: Omit<ConvExtrasEntry, "conversation_id" | "updatedAt">,
  workspaceId?: string,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    await mutateCollections([registry.collections.extras], () => {
      upsert(registry.collections.extras, conversationId, {
        conversation_id: conversationId,
        ...entry,
        updatedAt: Date.now(),
      })
    })
  } catch {}
}

export async function invalidateCache(
  conversationId: string,
  workspaceId?: string,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    const messageKeys = [...registry.collections.messages.entries()]
      .filter(([, message]) => message.conversation_id === conversationId)
      .map(([key]) => key)
    const pointerKeys = [...registry.collections.lastOpen.values()]
      .filter((row) => row.conversation_id === conversationId)
      .map((row) => row.key)
    await mutateCollections(Object.values(registry.collections), () => {
      if (messageKeys.length > 0) registry.collections.messages.delete(messageKeys)
      if (registry.collections.metas.has(conversationId)) {
        registry.collections.metas.delete(conversationId)
      }
      if (pointerKeys.length > 0) registry.collections.lastOpen.delete(pointerKeys)
      if (registry.collections.extras.has(conversationId)) {
        registry.collections.extras.delete(conversationId)
      }
    })
  } catch {}
}

export async function evictLRU(
  maxConversations = MAX_CONVERSATIONS,
  workspaceId?: string,
): Promise<void> {
  const pending = registryFor(workspaceId)
  if (!pending) return
  try {
    const registry = await pending
    const metas = [...registry.collections.metas.values()]
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    for (const meta of metas.slice(0, Math.max(0, metas.length - maxConversations))) {
      await invalidateCache(meta.conversation_id, registry.workspaceId)
    }
  } catch {}
}

export async function clearAllAgentChatPersistence(): Promise<void> {
  await Promise.allSettled([...registries.values()].map(async (pending) => {
    await (await pending).clear()
  }))
}

export async function resetAgentChatPersistenceForTests(): Promise<void> {
  const pending = [...registries.values()]
  registries.clear()
  activeWorkspaceId = null
  const resolved = await Promise.all(pending.map((registry) => registry.catch(() => null)))
  for (const registry of resolved) registry?.cleanup()
}
