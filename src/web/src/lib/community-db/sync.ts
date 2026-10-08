import type { Transaction } from "@tanstack/react-db"
import { currentSource, withSource } from "@/lib/observability/data-source"
import { communityRequestOptions as qualifiedCommunityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { isAbortError } from "@/lib/errors"
import { isOwnerServerDeleteScopeEvictionBlocked } from "@/lib/community/eject-server"

import { getCommunityRuntime, readCurrentCommunityChannelMeta } from "@/stores/community/runtime"
import { notifyManager,type QueryClient } from "@tanstack/react-query"
import { createStore } from "@tanstack/store"
import type { Query } from "@tanstack/react-query"
import {
UNCATEGORIZED_CATEGORY_ID,
FORUM_ARCHIVE_TAG,
normalizeCommunityChannelIdentity,
type CommunityChannelIdentity,
type CommunityMemberRelation,
type CommunityResourceProfile,
type CommunityMessageResource,
type AccountAttentionSnapshot,
type CommunityWsEvent,
type ServerRailProjection,
} from "@alook/shared"
import type { DmsResponse } from "@/hooks/community/use-dms"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type {
AccountReadStateSnapshot,
} from "@/hooks/community/community-ws/read-state-reconciliation"
import type { ServerDetail,ServersResponse } from "@/hooks/community/use-servers"
import { applyMessageReaction, messageProfileIds, type Msg, type MessageInput } from "@/lib/community/models/message"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import {
beginCommunityProfileSeed,
type CommunityProfileSeedSnapshot,
communityUserProfilePatch,
messageProfilePatches,
writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import type { CommunityProfilePatch } from "@/lib/community/models/people"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"


import { avatarInitial } from "@/lib/community/avatar"
import { projectCommunityMessageCreate, projectMessageRichContent } from "@/lib/community/message-wire"
import { clearTypingIndicator } from "@/hooks/community/community-ws/typing"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { takeMessageIdsForAccessScope } from "./message-access-scope"
import { clearLastChannel,getLastChannel } from "@/lib/community/last-channel"
import { clearLastMeLocation,getLastMeLeaf } from "@/lib/community/last-me-location"
import {
getCommunityDbRegistry,
type CommunityDbRegistry,
} from "./collections"
import {
channelMembershipKey,
canonicalChannelMembershipRow,
channelMembershipSchema,
channelSchema,
canonicalChannelRow,
folderItemKey,
messageSchema,
notificationSettingKey,
profileSchema,
serverMembershipKey,
serverSchema,
communityCollectionSchemas,
type CommunityCollectionRows,
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
type ReadStateClockRow,
type ReadStateRow,
type ServerMembershipRow,
type ServerRow,
} from "./schema"
import type { z } from "zod"
import { writeCommunityCollectionRows } from "./write"
import type { CommunityThreadResources } from "@/hooks/community/forum-feed-window"

type CollectionName = keyof CommunityDbRegistry["collections"]
type SnapshotIngestMode = "authoritative" | "merge"

type CanonicalRevisionState = {
  revision: number
  entityRevisions: Map<string, number>
  fieldRevisions: Map<string, Map<string, number>>
  pendingOperations: Map<string, CanonicalPendingOperation[]>
}

type CanonicalPendingOperation =
  | { revision: number; kind: "patch"; apply: (row: object) => object }
  | { revision: number; kind: "delete" }

type CanonicalWriteContext =
  | { kind: "event" }
  | { kind: "query"; requestRevision: number; profileSnapshot: CommunityProfileSeedSnapshot }

const canonicalRevisionStates = new WeakMap<QueryClient, ReturnType<typeof createStore<CanonicalRevisionState>>>()
const canonicalWriteContexts = new WeakMap<QueryClient, CanonicalWriteContext>()

function writeCanonicalProfilePatches(registry: CommunityDbRegistry, patches: readonly CommunityProfilePatch[]) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  return writeCommunityProfilePatches(patches, registry, context?.kind === "query" ? { snapshot: context.profileSnapshot } : { event: context?.kind === "event" })
}

function canonicalRevisionStore(queryClient: QueryClient) {
  let state = canonicalRevisionStates.get(queryClient)
  if (!state) {
    state = createStore<CanonicalRevisionState>({ revision: 0, entityRevisions: new Map(), fieldRevisions: new Map(), pendingOperations: new Map() })
    canonicalRevisionStates.set(queryClient, state)
  }
  return state
}

function canonicalRevisionState(queryClient: QueryClient) {
  return canonicalRevisionStore(queryClient).get()
}

function updateCanonicalRevisions(queryClient: QueryClient, update: (state: CanonicalRevisionState) => void) {
  canonicalRevisionStore(queryClient).setState((previous) => {
    const state = { ...previous, entityRevisions: new Map(previous.entityRevisions), fieldRevisions: new Map(previous.fieldRevisions), pendingOperations: new Map(previous.pendingOperations) }
    update(state)
    return state
  })
}

function canonicalEntityKey(name: CollectionName, key: string) {
  return `${name}:${key}`
}

function isProtectedFromQueryWrite(
  registry: CommunityDbRegistry,
  name: CollectionName,
  key: string,
) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  if (context?.kind !== "query") return false
  return (canonicalRevisionState(registry.queryClient).entityRevisions.get(
    canonicalEntityKey(name, key),
  ) ?? 0) > context.requestRevision
}

function recordEventWrites(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
  fields: readonly string[] = ["*"],
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    for (const field of fields) revisions.set(field, state.revision)
    state.fieldRevisions.set(entityKey, revisions)
   }
  })
}

function recordEventPatches<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
  patch: (row: T) => T,
  presentKeys: ReadonlySet<string>,
  fields: readonly string[] = ["*"],
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    for (const field of fields) revisions.set(field, state.revision)
    state.fieldRevisions.set(entityKey, revisions)
    if (presentKeys.has(key)) {
      state.pendingOperations.delete(entityKey)
      continue
    }
    const pending = [...(state.pendingOperations.get(entityKey) ?? [])]
    pending.push({
      revision: state.revision,
      kind: "patch",
      apply: patch as unknown as (row: object) => object,
    })
    state.pendingOperations.set(entityKey, pending)
   }
  })
}

function recordEventDeletes(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  updateCanonicalRevisions(registry.queryClient, (state) => {
   for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    const revisions = new Map(state.fieldRevisions.get(entityKey))
    revisions.set("*", state.revision)
    state.fieldRevisions.set(entityKey, revisions)
    state.pendingOperations.set(entityKey, [{
      revision: state.revision,
      kind: "delete",
    }])
   }
  })
}

function clearPendingOperations(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  updateCanonicalRevisions(registry.queryClient, (state) => {
    for (const key of keys) state.pendingOperations.delete(canonicalEntityKey(name, key))
  })
}

function mergePendingOperationsIntoQueryRow<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  key: string,
  schema: z.ZodType<T>,
  incoming: T,
) {
  const context = canonicalWriteContexts.get(registry.queryClient)
  if (context?.kind !== "query") return incoming
  const operations = canonicalRevisionState(registry.queryClient).pendingOperations
    .get(canonicalEntityKey(name, key))
    ?.filter((operation) => operation.revision > context.requestRevision)
  if (!operations?.length) return undefined
  let next: object | undefined = incoming
  for (const operation of operations) {
    if (operation.kind === "delete") next = undefined
    else if (next) next = operation.apply(next)
  }
  if (!next) return undefined
  clearPendingOperations(registry, name, [key])
  return schema.parse(next)
}

function withCanonicalWriteContext<T>(
  queryClient: QueryClient,
  context: CanonicalWriteContext,
  publish: () => T,
) {
  const previous = canonicalWriteContexts.get(queryClient)
  canonicalWriteContexts.set(queryClient, context)
  try {
    return withSource(queryClient, currentSource(queryClient) === "ws" ? "ws" : context.kind === "query" ? "network" : "local_mutation", publish)
  } finally {
    if (previous) canonicalWriteContexts.set(queryClient, previous)
    else canonicalWriteContexts.delete(queryClient)
  }
}

function collectionSchema<N extends CollectionName>(name: N) {
  return communityCollectionSchemas[name] as unknown as z.ZodType<CommunityCollectionRows[N]>
}

function collectionRows<N extends CollectionName>(registry: CommunityDbRegistry, name: N): CommunityCollectionRows[N][] {
  const schema = collectionSchema(name)
  const values = registry.queryClient.getQueryData<unknown[]>(communityKeys.communityDbCollection(registry.scopeId, name))
    ?? Array.from<unknown>(registry.collections[name].values())
  return values.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

function collectionKey<N extends CollectionName>(registry: CommunityDbRegistry, name: N) {
  const collection = registry.collections[name] as { getKeyFromItem: (row: CommunityCollectionRows[N]) => string }
  return (row: CommunityCollectionRows[N]) => collection.getKeyFromItem(row)
}

function replaceRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  incoming: CommunityCollectionRows[N][],
  owns: (row: CommunityCollectionRows[N]) => boolean,
) {
  const schema = collectionSchema(name)
  const getKey = collectionKey(registry, name)
  const parsedIncoming = incoming.map((row) => schema.parse(row))
  const current = collectionRows(registry, name)
  const nextByKey = new Map(current.flatMap((row) => {
    const key = getKey(row)
    return !owns(row) || isProtectedFromQueryWrite(registry, name, key)
      ? [[key, row] as const]
      : []
  }))
  for (const row of parsedIncoming) {
    const key = getKey(row)
    if (!isProtectedFromQueryWrite(registry, name, key)) {
      nextByKey.set(key, row)
      clearPendingOperations(registry, name, [key])
      continue
    }
    if (nextByKey.has(key)) {
      clearPendingOperations(registry, name, [key])
      continue
    }
    const merged = mergePendingOperationsIntoQueryRow(registry, name, key, schema, row)
    if (merged) nextByKey.set(key, merged)
  }
  const next = [...nextByKey.values()]
  writeCommunityCollectionRows(registry, name, next, getKey)
  if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  recordEventWrites(registry, name, [
    ...current.filter(owns).map(getKey),
    ...parsedIncoming.map(getKey),
  ])
}

function upsertRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  incoming: CommunityCollectionRows[N][],
) {
  replaceRows(registry, name, incoming, () => false)
}

function promoteServerDetailComplete(
  registry: CommunityDbRegistry,
  serverId: string,
) {
  const current = collectionRows(registry, "servers")
  let changed = false
  const next = current.map((row) => {
    if (row.id !== serverId || row.detailComplete) return row
    changed = true
    return serverSchema.parse({ ...row, detailComplete: true })
  })
  if (!changed) return
  writeCommunityCollectionRows(registry, "servers", next, (row) => row.id)
}

function patchRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  patch: (row: CommunityCollectionRows[N]) => CommunityCollectionRows[N],
  matches: (row: CommunityCollectionRows[N]) => boolean,
  eventKeys?: Iterable<string>,
  eventFields?: readonly string[],
) {
  const schema = collectionSchema(name)
  const getKey = collectionKey(registry, name)
  const current = collectionRows(registry, name)
  let changed = false
  const changedKeys: string[] = []
  const next = current.map((row) => {
    if (!matches(row)) return row
    const key = getKey(row)
    if (isProtectedFromQueryWrite(registry, name, key)) return row
    changed = true
    changedKeys.push(key)
    return schema.parse(patch(row))
  })
  if (changed) {
    writeCommunityCollectionRows(registry, name, next, getKey)
    if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  }
  if (eventKeys) {
    recordEventPatches(registry, name, eventKeys, patch, new Set(changedKeys), eventFields)
  }
  else recordEventWrites(registry, name, changedKeys, eventFields)
  return changed
}

function deleteRows<N extends CollectionName>(
  registry: CommunityDbRegistry,
  name: N,
  remove: (row: CommunityCollectionRows[N]) => boolean,
  eventKeys?: Iterable<string>,
) {
  const getKey = collectionKey(registry, name)
  const current = collectionRows(registry, name)
  const removedKeys: string[] = []
  const next = current.filter((row) => {
    if (!remove(row)) return true
    const key = getKey(row)
    if (isProtectedFromQueryWrite(registry, name, key)) return true
    removedKeys.push(key)
    return false
  })
  writeCommunityCollectionRows(registry, name, next, getKey)
  if (name === "attentionScopes" || name === "attentionItems") rebaseAttentionTransactions(registry)
  if (eventKeys) recordEventDeletes(registry, name, eventKeys)
  else recordEventWrites(registry, name, removedKeys)
}

function referencedProfileIds(registry: CommunityDbRegistry) {
  const ids = new Set<string>(registry.accountId ? [registry.accountId] : [])
  for (const row of collectionRows(registry, "servers")) {
    if (row.ownerId) ids.add(row.ownerId)
  }
  for (const row of collectionRows(registry, "serverMemberships")) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "channelMemberships")) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "friendships")) ids.add(row.userId)
  for (const row of collectionRows(registry, "messages")) {
    for (const id of messageProfileIds(row as MessageRow & Msg)) ids.add(id)
  }
  return ids
}

function garbageCollectCommunityProfiles(registry: CommunityDbRegistry) {
  const referenced = referencedProfileIds(registry)
  deleteRows(
    registry,
    "profiles",
    (row) => !referenced.has(row.userId),
  )
}

function pruneInboxCaches(
  queryClient: QueryClient,
  channelIds: ReadonlySet<string>,
  serverId: string | null,
) {
  queryClient.setQueryData<{
    friendRequests: unknown[]
    servers: Array<{
      serverId: string
      channels: Array<{ channelId: string; children: Array<{ channelId: string }> }>
    }>
    dms: Array<{ channelId: string }>
  } | undefined>(communityKeys.inboxUnreads(), (current) => {
    if (!current) return current
    const servers = current.servers.flatMap((server) => {
      if (serverId && server.serverId === serverId) return []
      const channels = server.channels.flatMap((channel) => {
        if (channelIds.has(channel.channelId)) return []
        const children = channel.children.filter((child) => !channelIds.has(child.channelId))
        return [{ ...channel, children }]
      })
      return channels.length > 0 ? [{ ...server, channels }] : []
    })
    return {
      ...current,
      servers,
      dms: current.dms.filter((dm) => !channelIds.has(dm.channelId)),
    }
  })
  queryClient.setQueryData<{
    mentions: Array<{ channelId?: string; serverId?: string }>
  } | undefined>(communityKeys.inboxMentions(), (current) => current ? {
    ...current,
    mentions: current.mentions.filter((entry) => (
      !entry.channelId || !channelIds.has(entry.channelId)
    ) && (!serverId || entry.serverId !== serverId)),
  } : current)
  queryClient.setQueryData<{
    marked: Array<{ channelId: string; serverId: string | null }>
  } | undefined>(communityKeys.inboxMarked(), (current) => current ? {
    ...current,
    marked: current.marked.filter((entry) => (
      !channelIds.has(entry.channelId) && (!serverId || entry.serverId !== serverId)
    )),
  } : current)
  void queryClient.invalidateQueries({
    queryKey: communityKeys.inbox(),
    refetchType: "active",
  })
}

function clearChannelTransientState(
  registry: CommunityDbRegistry,
  channelIds: ReadonlySet<string>,
  serverId: string | null,
  preserveQuery?: Query,
  options?: { queries?: ReadonlySet<Query>; assertView?: () => void },
) {
  const messageIds = new Set([
    ...takeMessageIdsForAccessScope(registry.queryClient, channelIds, serverId),
    ...collectionRows(registry, "messages")
      .filter((row) => channelIds.has(row.channelId))
      .map((row) => row.id),
  ])
  for (const messageId of messageIds) {
    void registry.queryClient.cancelQueries({
      queryKey: communityKeys.message(messageId),
      exact: true,
    })
    registry.queryClient.removeQueries({
      queryKey: communityKeys.message(messageId),
      exact: true,
    })
  }
  if (channelIds.size === 0) return
  for (const entry of registry.runtime.messageStream.get().entries.values()) {
    if (channelIds.has(entry.scope.id)) registry.runtime.messageStream.actions.removeScope(entry.scope)
  }
  const community = registry.runtime.ui.get()
  const unreadProjection = getAccountUnreadProjection(
    registry.queryClient,
    registry.accountId ?? "__anonymous__",
  )
  for (const channelId of channelIds) {
    unreadProjection.retireAccessScope({ kind: "channel", channelId })
    for (const scope of [`ch:${channelId}`, `dm:${channelId}`]) {
      for (const userId of community.typingByScope.get(scope)?.keys() ?? []) {
        clearTypingIndicator(registry.queryClient, scope, userId)
      }
    }
  }
  pruneInboxCaches(registry.queryClient, channelIds, null)
  if (serverId) {
    const remembered = getLastChannel(serverId)
    if (remembered && channelIds.has(remembered)) clearLastChannel(serverId)
  } else {
    const remembered = getLastMeLeaf()
    if (remembered && channelIds.has(remembered)) clearLastMeLocation()
  }
  let viewCurrent = true
  try { options?.assertView?.() } catch { viewCurrent = false }
  if (viewCurrent && !preserveQuery && community.currentChannelId && channelIds.has(community.currentChannelId)) {
    registry.runtime.ui.actions.setCurrentChannelId(null)
  }
  const subscription = { ...community.subscription }
  if (subscription.channelId && channelIds.has(subscription.channelId)) delete subscription.channelId
  if (subscription.secondaryChannelId && channelIds.has(subscription.secondaryChannelId)) {
    delete subscription.secondaryChannelId
    registry.runtime.ui.setState((state) => ({ ...state, secondaryChannelOwner: null }))
  }
  if (subscription.dmConversationId && channelIds.has(subscription.dmConversationId)) {
    delete subscription.dmConversationId
  }
  registry.runtime.ui.setState((state) => ({ ...state, subscription }))
  if (community.pendingReply && channelIds.has(community.pendingReply.channelId)) {
    registry.runtime.ui.actions.setPendingReply(null)
  }
  const predicate = (query: Query) => {
    if (query === preserveQuery || options?.queries && !options.queries.has(query)) return false
    const key = query.queryKey
    if (key[0] !== "community" || key[1] === "db") return false
    if ((key[1] === "channel" || key[1] === "dm") && channelIds.has(String(key[2]))) return true
    if (key[1] === "message-context" && channelIds.has(String(key[3]))) return true
    if (key[1] === "servers" && (!serverId || key[2] === serverId) && (key[3] === "channel-meta" || key[3] === "forum-sidebar-retained") && channelIds.has(String(key[4]))) return true
    const data = query.state.data as { channelId?: unknown; scope?: { channelId?: unknown } } | undefined
    return typeof data?.channelId === "string" && channelIds.has(data.channelId)
      || typeof data?.scope?.channelId === "string" && channelIds.has(data.scope.channelId)
  }
  void registry.queryClient.cancelQueries({ predicate })
  registry.queryClient.removeQueries({ predicate })
}

export function ingestServers(
  registry: CommunityDbRegistry,
  response: ServersResponse,
) {
  const currentServers = collectionRows(registry, "servers")
  const existingById = new Map(currentServers.map((server) => [server.id, server]))
  const incomingServerIds = new Set(response.servers.map((server) => server.id))
  const removedServerIds = currentServers
    .filter((server) => !incomingServerIds.has(server.id))
    .map((server) => server.id)
  const servers: ServerRow[] = response.servers.map((server, position) => ({
    id: server.id,
    position,
    name: server.name,
    discriminator: server.discriminator ?? "",
    description: server.description ?? "",
    ownerId: server.ownerId ?? "",
    icon: server.icon ?? null,
    official: server.official === true,
    isOwner: server.isOwner === true,
    unread: server.unread,
    mentions: server.mentions,
    detailComplete: existingById.get(server.id)?.detailComplete ?? false,
  }))
  const viewerId = registry.accountId
  const memberships: ServerMembershipRow[] = viewerId
    ? response.servers.map((server) => ({
        id: serverMembershipKey(server.id, viewerId),
        serverId: server.id,
        userId: viewerId,
        role: server.role ?? (server.isOwner ? "owner" : "member"),
        ...(server.memberId ? { memberId: server.memberId } : {}),
        viewer: true,
      }))
    : []
  notifyManager.batch(() => {
    for (const serverId of removedServerIds) if (!isOwnerServerDeleteScopeEvictionBlocked(registry.queryClient, serverId)) purgeCommunityServer(registry, serverId)
    replaceRows(registry, "servers", servers, (row) => !isOwnerServerDeleteScopeEvictionBlocked(registry.queryClient, row.id))
    if (viewerId) {
      replaceRows(
        registry,
        "serverMemberships",
        memberships,
        (row) => row.viewer,
      )
    }
  })
}

export function ingestServerDetail(
  registry: CommunityDbRegistry,
  detail: ServerDetail,
) {
  const existing = collectionRows(registry, "servers")
    .find((row) => row.id === detail.id)
  const server: ServerRow = {
    id: detail.id,
    position: existing?.position ?? 0,
    name: detail.name,
    discriminator: detail.discriminator,
    description: detail.description,
    ownerId: detail.ownerId,
    icon: detail.icon,
    official: detail.official === true,
    isOwner: existing?.isOwner ?? detail.ownerId === registry.accountId,
    unread: existing?.unread ?? false,
    mentions: existing?.mentions ?? 0,
    detailComplete: true,
  }
  const categories: CategoryRow[] = []
  const channels: ChannelRow[] = []
  detail.categories.forEach((category, categoryIndex) => {
    const uncategorized = category.id === UNCATEGORIZED_CATEGORY_ID
    if (!uncategorized) {
      categories.push({
        id: category.id,
        serverId: detail.id,
        name: category.name,
        position: categoryIndex,
        private: category.private === true || category.private === 1,
        creatorId: category.creatorId,
        pending: category.pending === true,
      })
    }
    category.channels.forEach((channel, channelIndex) => {
      channels.push(canonicalChannelRow({
        id: channel.id,
        serverId: detail.id,
        categoryId: uncategorized ? null : category.id,
        name: channel.name,
        type: channel.type ?? "text",
        parentChannelId: null,
        parentMessageId: null,
        creatorId: channel.creatorId,
        position: channelIndex,
        archived: false,
        muted: channel.muted === true,
        unread: channel.unread,
        ...(channel.type === "forum" ? {
          baseUnread: detail.forumUnreadState?.[channel.id]?.baseUnread ?? channel.unread,
        } : {}),
        tags: channel.tags ?? [],
        pending: channel.pending === true,
        lastMessageAt: null,
      }))
    })
  })
  const currentTopLevelIds = new Set(
    collectionRows(registry, "channels")
      .filter((row) => row.serverId === detail.id && row.type !== "thread")
      .map((row) => row.id),
  )
  const incomingTopLevelIds = new Set(channels.map((row) => row.id))
  const removedTopLevelIds = [...currentTopLevelIds]
    .filter((channelId) => !incomingTopLevelIds.has(channelId))
  const viewerId = registry.accountId
  const accessMemberships: ChannelMembershipRow[] = viewerId
    ? channels.map((channel) => (canonicalChannelMembershipRow(channel.id, viewerId, "access", { source: "inherited" })))
    : []
  const existingChannels = new Map(
    collectionRows(registry, "channels").map((row) => [row.id, row]),
  )
  const unreadChildOwnership = Object.entries(detail.forumUnreadState ?? {})
    .flatMap(([parentChannelId, state]) => state.childIds.map((childId) => ({
      childId,
      parentChannelId,
    })))
  const unreadChildStubs: ChannelRow[] = unreadChildOwnership.flatMap((ownership) => {
    if (existingChannels.has(ownership.childId)) return []
    return [canonicalChannelRow({
      id: ownership.childId,
      serverId: detail.id,
      type: "thread" as const,
      parentChannelId: ownership.parentChannelId,
      unread: true,
    })]
  })
  const unreadChildMemberships: ChannelMembershipRow[] = viewerId
    ? unreadChildOwnership.flatMap(({ childId }) => ([
        canonicalChannelMembershipRow(childId, viewerId, "access", { source: "explicit" as const }),
        canonicalChannelMembershipRow(childId, viewerId, "notify", { source: "explicit" as const }),
      ]))
    : []
  const authoritativeTopLevelIds = new Set([...currentTopLevelIds, ...incomingTopLevelIds])
  notifyManager.batch(() => {
    for (const channelId of removedTopLevelIds) purgeCommunityChannel(registry, channelId)
    upsertRows(registry, "servers", [server])
    // Completeness is monotonic query state, not mutable server identity. A
    // newer WS event may protect the row's fields without blocking this proof
    // that its canonical tree has arrived.
    promoteServerDetailComplete(registry, detail.id)
    replaceRows(
      registry,
      "categories",
      categories,
      (row) => row.serverId === detail.id,
    )
    replaceRows(
      registry,
      "channels",
      channels,
      (row) => row.serverId === detail.id && row.type !== "thread",
    )
    if (viewerId) {
      replaceRows(
        registry,
        "channelMemberships",
        accessMemberships,
        (row) => row.userId === viewerId
          && row.relation === "access"
          && authoritativeTopLevelIds.has(row.channelId),
      )
      upsertRows(
        registry,
        "channelMemberships",
        unreadChildMemberships,
      )
    }
    upsertRows(registry, "channels", unreadChildStubs)
    const unreadChildren = new Set(
      Object.values(detail.forumUnreadState ?? {}).flatMap((state) => state.childIds),
    )
    patchRows(
      registry,
      "channels",
      (row) => ({ ...row, unread: unreadChildren.has(row.id) }),
      (row) => row.serverId === detail.id && row.type === "thread",
    )
  })
}

function ingestChannelMetadata(
  registry: CommunityDbRegistry,
  input: unknown,
  proof?: CommunityFreshQueryProof,
) {
  const metadata = normalizeCommunityChannelIdentity(input)
  const hints = channelSchema.pick({ openerSeq: true, openerUnread: true }).parse(input)
  const changes = { ...metadata, ...hints, name: metadata.name ?? "", pending: false }
  const existing = registry.collections.channels.get(metadata.id)
  if (proof && existing) {
    publishConfirmedFields(registry.queryClient, "channels", metadata.id, changes, proof)
  } else {
    upsertRows(registry, "channels", [canonicalChannelRow(changes, existing)])
  }
}

export function ingestDms(
  registry: CommunityDbRegistry,
  response: DmsResponse,
  mode: SnapshotIngestMode = "authoritative",
) {
  const viewerId = registry.accountId
  if (!viewerId) return
  const currentDmIds = new Set(
    collectionRows(registry, "channels")
      .filter((row) => row.type === "dm")
      .map((row) => row.id),
  )
  const channels: ChannelRow[] = []
  const memberships: ChannelMembershipRow[] = []
  const profilePatches: CommunityProfilePatch[] = []
  for (const [position, dm] of response.conversations.entries()) {
    channels.push(canonicalChannelRow({
      id: dm.id, type: "dm", position,
      unread: dm.unread === true, lastMessageAt: dm.activityAt ?? null, preview: dm.preview,
      ...(dm.lastUnreadSeq === undefined ? {} : { lastUnreadSeq: dm.lastUnreadSeq }),
    }))
    memberships.push(
      canonicalChannelMembershipRow(dm.id, viewerId, "access"),
      canonicalChannelMembershipRow(dm.id, dm.userId, "access"),
    )
    profilePatches.push(communityUserProfilePatch(dm.userId, dm))
  }
  const dmIds = new Set(channels.map((row) => row.id))
  const authoritativeDmIds = new Set([...currentDmIds, ...dmIds])
  const removedDmIds = [...currentDmIds].filter((channelId) => !dmIds.has(channelId))
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      for (const channelId of removedDmIds) purgeCommunityChannel(registry, channelId)
      replaceRows(registry, "channels", channels, (row) => row.type === "dm")
      replaceRows(
        registry,
        "channelMemberships",
        memberships,
        (row) => row.relation === "access" && authoritativeDmIds.has(row.channelId),
      )
    } else {
      upsertRows(registry, "channels", channels)
      upsertRows(
        registry,
        "channelMemberships",
        memberships,
      )
    }
    writeCanonicalProfilePatches(registry, profilePatches)
  })
}

/**
 * Projects one locally confirmed DM summary before navigation. This is an
 * additive event write: it cannot remove sibling conversations, and its
 * revision fence prevents an older in-flight `/dms` snapshot from deleting
 * the destination before the route mounts.
 */
export function publishCommunityDmSummary(
  queryClient: QueryClient,
  dm: DmsResponse["conversations"][number],
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    ingestDms(registry, { conversations: [dm] }, "merge")
    return "published" as const
  })
}

function ingestFolders(
  registry: CommunityDbRegistry,
  response: FoldersResponse,
) {
  const folders: FolderRow[] = response.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    position: folder.position,
  }))
  const items: FolderItemRow[] = response.folders.flatMap((folder) => (
    folder.servers.map((server, position) => ({
      id: folderItemKey(folder.id, server.id),
      folderId: folder.id,
      serverId: server.id,
      position,
    }))
  ))
  notifyManager.batch(() => {
    replaceRows(registry, "folders", folders, () => true)
    replaceRows(registry, "folderItems", items, () => true)
  })
}

export function publishCommunityServerRailCommit(queryClient: QueryClient, projection: ServerRailProjection, proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    if (projection.reorderServers) {
      const positions = new Map(projection.after.serverOrder.map((id, position) => [id, position]))
      withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
        patchRows(registry, "servers", (row) => ({ ...row, position: positions.get(row.id)! }), (row) => positions.has(row.id), undefined, ["position"])
      })
    }
    const affected = new Set([...projection.affectedFolderIds, ...projection.createdFolders.map((row) => row.id), ...(projection.reorderFolders ? projection.after.folderOrder : [])])
    const folders = projection.after.folderOrder.filter((id) => affected.has(id)).map((id) => ({ id, name: projection.after.folders[id]!.name, position: projection.after.folderOrder.indexOf(id) }))
    const knownServers = new Set(collectionRows(registry, "servers").map((row) => row.id))
    const allowed = new Set(collectionRows(registry, "serverMemberships").filter((row) => row.viewer && row.userId === registry.accountId && knownServers.has(row.serverId)).map((row) => row.serverId))
    const items = folders.flatMap((folder) => projection.after.folders[folder.id]!.serverIds.filter((serverId) => allowed.has(serverId)).map((serverId, position) => ({ id: folderItemKey(folder.id, serverId), folderId: folder.id, serverId, position })))
    notifyManager.batch(() => {
      replaceRows(registry, "folders", folders, (row) => affected.has(row.id))
      replaceRows(registry, "folderItems", items, (row) => affected.has(row.folderId))
    })
    return "published" as const
  })
}

export function ingestMessages(
  registry: CommunityDbRegistry,
  channelId: string,
  messages: readonly (MessageInput | CommunityMessageResource)[],
) {
  const previous = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const rows: MessageRow[] = messages
    .filter((message) => !message.id.startsWith("temp_") && !("failed" in message && message.failed === true))
    .map((message) => {
      const { thread, clientNonce, ...fields } = message
      const existingMessage = previous.get(message.id)
      if (thread) {
        const existing = collectionRows(registry, "channels").find((row) => row.id === thread.id)
        const parent = collectionRows(registry, "channels").find((row) => row.id === channelId)
        upsertRows(registry, "channels", [canonicalChannelRow({
          id: thread.id, serverId: existing?.serverId ?? parent?.serverId, categoryId: null,
          name: thread.name, type: "thread", parentChannelId: channelId, parentMessageId: message.id,
          tags: thread.tags ?? existing?.tags ?? [], pending: false, messageCount: thread.messageCount,
          ...(thread.lastReplyAt ? { lastMessageAt: thread.lastReplyAt } : {}),
          ...(thread.preview !== undefined ? { preview: thread.preview } : {}),
          ...(thread.participantCount !== undefined ? { participantCount: thread.participantCount } : {}),
        }, existing)])
      }
      return { ...fields, ...projectMessageRichContent(fields), type: message.type ?? existingMessage?.type ?? "chat", channelId,
        ...("clientNonce" in message ? { clientNonce: clientNonce ?? undefined } : {}),
        ...("replyTo" in message || "replyToId" in message || !existingMessage
          ? { replyToId: message.replyTo?.id ?? ("replyToId" in message ? message.replyToId : null) } : {}),
      }
    })
  upsertRows(registry, "messages", rows)
  writeCanonicalProfilePatches(registry, messageProfilePatches(messages))
}

export function ingestReadStateSnapshot(
  registry: CommunityDbRegistry,
  snapshot: AccountReadStateSnapshot,
) {
  const currentRevision = collectionRows(registry, "readStateClock")
    .find((row) => row.id === "account")?.revision ?? -1
  if (snapshot.revision <= currentRevision) return
  const readStates: ReadStateRow[] = snapshot.readStates.map((row) => ({ ...row }))
  const clock: ReadStateClockRow = { id: "account", revision: snapshot.revision }
  notifyManager.batch(() => {
    replaceRows(registry, "readStates", readStates, () => true)
    replaceRows(registry, "readStateClock", [clock], () => true)
  })
}

function serverSummaryRows(registry: CommunityDbRegistry, summaries: readonly Pick<ServerRow, "id" | "name" | "discriminator">[]): ServerRow[] {
  const existingById = new Map(collectionRows(registry, "servers").map((row) => [row.id, row]))
  return summaries.map((server, position) => {
    const existing = existingById.get(server.id)
    return {
      description: "", ownerId: "", icon: null, official: false, isOwner: false,
      unread: false, mentions: 0, detailComplete: false, ...existing,
      id: server.id, position: existing?.position ?? position,
      name: server.name, discriminator: server.discriminator,
    }
  })
}

function seedViewerServerMemberships(registry: CommunityDbRegistry, servers: readonly Pick<ServerRow, "id" | "isOwner">[]) {
  const viewerId = registry.accountId
  if (!viewerId) return
  const existingById = new Map(collectionRows(registry, "serverMemberships").map((row) => [row.id, row]))
  upsertRows(registry, "serverMemberships", servers.map((server) => {
    const id = serverMembershipKey(server.id, viewerId), existing = existingById.get(id)
    return { ...existing, id, serverId: server.id, userId: viewerId,
      role: existing?.role ?? (server.isOwner ? "owner" : "member"), viewer: true }
  }))
}

function ingestAttentionIncluded(
  registry: CommunityDbRegistry,
  included: Partial<AccountAttentionSnapshot["included"]> | undefined,
) {
  const existingChannels = new Map(
    collectionRows(registry, "channels").map((row) => [row.id, row]),
  )
  const viewerId = registry.accountId
  const servers = serverSummaryRows(registry, included?.servers ?? [])
  upsertRows(registry, "servers", servers)
  for (const channel of included?.channels ?? []) ingestChannelMetadata(registry, channel)
  const dmChannels: ChannelRow[] = (included?.dms ?? []).map((dm, position) => {
    const existing = existingChannels.get(dm.id)
    return canonicalChannelRow({
      id: dm.id,
      type: "dm",
      position: existing?.position ?? position,
      muted: existing?.muted ?? false,
      unread: true,
      lastMessageAt: dm.lastMessageAt,
      preview: existing?.preview ?? "",
      lastUnreadSeq: dm.lastUnreadSeq,
    })
  })
  upsertRows(registry, "channels", dmChannels)
  if (viewerId) {
    seedViewerServerMemberships(registry, servers)
    upsertRows(
      registry,
      "channelMemberships",
      [
        ...(included?.channels ?? []).map((channel) => (canonicalChannelMembershipRow(channel.id, viewerId, "access", { source: "inherited" as const }))),
        ...(included?.dms ?? []).flatMap((dm) => [canonicalChannelMembershipRow(dm.id, viewerId, "access"), canonicalChannelMembershipRow(dm.id, dm.userId, "access")]),
      ],
    )
  }
  const profiles = profileSchema.array().safeParse(included?.profiles ?? [])
  if (profiles.success) {
    writeCanonicalProfilePatches(registry, profiles.data.map((profile) => (
      communityUserProfilePatch(profile.userId, profile)
    )))
  }
  const messages = messageSchema.array().safeParse(included?.messages ?? [])
  if (messages.success) {
    const current = new Map(
      collectionRows(registry, "messages").map((row) => [row.id, row]),
    )
    const merged = messages.data.map((message) => ({
      ...current.get(message.id),
      ...Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)),
    })) as MessageRow[]
    upsertRows(registry, "messages", merged)
  }
}

type AttentionDomain = "channels" | "dms" | "mentions"
type AttentionFloor = {
  throughSeq: number
  clearedCount: number
  domain: "channels" | "dms"
  ordinary: boolean
  mentions: boolean
}
type AttentionIntent = {
  token: symbol
  generation: number
  scopesQuery: Query | undefined
  itemsQuery: Query | undefined
  floors: ReadonlyMap<string, AttentionFloor>
  itemIds: ReadonlySet<string>
  itemDomains: ReadonlyMap<string, AttentionDomain>
  scopeId?: string
  targetSeq?: number
  clearedAttentionCount: number
  outcome: Promise<ReadonlySet<AttentionDomain> | undefined>
  resolveOutcome: (domains: ReadonlySet<AttentionDomain> | undefined) => void
  settled: Promise<boolean>
  resolveSettled: (success: boolean) => void
}
type AttentionTransaction = Transaction<Record<string, unknown>>
type AttentionTransactionState = {
  intents: ReadonlyMap<symbol, AttentionIntent>
  transactions: ReadonlyMap<symbol, AttentionTransaction>
  rebasing: boolean
  preload: Promise<void> | null
}
const attentionTransactionStores = new WeakMap<CommunityDbRegistry, ReturnType<typeof createStore<AttentionTransactionState>>>()

function attentionTransactionStore(registry: CommunityDbRegistry) {
  let store = attentionTransactionStores.get(registry)
  if (store) return store
  store = createStore<AttentionTransactionState>({ intents: new Map(), transactions: new Map(), rebasing: false, preload: null })
  attentionTransactionStores.set(registry, store)
  const original = store
  const unsubscribe = registry.queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "removed" && (event.type !== "updated" || event.action.type !== "success")) return
    if (original.get().intents.size === 0) return
    const key = event.query.queryKey
    if (JSON.stringify(key) !== JSON.stringify(communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"))
      && JSON.stringify(key) !== JSON.stringify(communityKeys.communityDbCollection(registry.scopeId, "attentionItems"))) return
    if (!original.get().rebasing) queueMicrotask(() => rebaseAttentionTransactions(registry))
  })
  const retire = registry.runtime.lifecycle.subscribe(() => {
    if (registry.runtime.lifecycle.get().active) return
    for (const intent of original.get().intents.values()) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
    original.setState((state) => ({ ...state, rebasing: true, intents: new Map() }))
    for (const transaction of original.get().transactions.values()) if (transaction.state !== "completed" && transaction.state !== "failed") transaction.rollback({ isSecondaryRollback: true })
    original.setState(() => ({ intents: new Map(), transactions: new Map(), rebasing: false, preload: null }))
    attentionTransactionStores.delete(registry)
    unsubscribe()
    retire.unsubscribe()
  })
  return store
}

function attentionIntentActive(registry: CommunityDbRegistry, intent: AttentionIntent) {
  const lifecycle = registry.runtime.lifecycle.get()
  return lifecycle.active && lifecycle.generation === intent.generation
    && getCommunityDbRegistry(registry.queryClient) === registry
    && registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"), exact: true }) === intent.scopesQuery
    && registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionItems"), exact: true }) === intent.itemsQuery
}

function attentionProjection(
  registry: CommunityDbRegistry,
  scopes: AttentionScopeRow[],
  items: AttentionItemRow[],
  intents: Iterable<AttentionIntent>,
) {
  const floors = new Map<string, { ordinary: number; mentions: number; cleared: number }>()
  const itemIds = new Set<string>()
  for (const intent of intents) {
    for (const id of intent.itemIds) itemIds.add(id)
    for (const [id, floor] of intent.floors) {
      const previous = floors.get(id) ?? { ordinary: -1, mentions: -1, cleared: 0 }
      floors.set(id, {
        ordinary: floor.ordinary ? Math.max(previous.ordinary, floor.throughSeq) : previous.ordinary,
        mentions: floor.mentions ? Math.max(previous.mentions, floor.throughSeq) : previous.mentions,
        cleared: floor.mentions ? Math.max(previous.cleared, floor.clearedCount) : previous.cleared,
      })
    }
  }
  const messages = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const seqOf = (item: AttentionItemRow) => item.readTarget?.seq ?? item.openerSeq ?? (item.messageId ? messages.get(item.messageId)?.seq : undefined)
  const removedByScope = new Map<string, number>()
  const survivingByScope = new Map<string, number>()
  const nextItems = items.filter((item) => {
    const floor = item.scopeId ? floors.get(item.scopeId) : undefined
    const seq = seqOf(item)
    const read = floor && (seq !== undefined ? seq <= floor.mentions : floor.mentions >= 0 && itemIds.has(item.id))
    const removed = itemIds.has(item.id) || read
    if (item.scopeId && (item.kind === "mention" || item.kind === "reply")) {
      if (removed && !read) removedByScope.set(item.scopeId, (removedByScope.get(item.scopeId) ?? 0) + 1)
      if (!removed) survivingByScope.set(item.scopeId, (survivingByScope.get(item.scopeId) ?? 0) + 1)
    }
    return !removed
  })
  const nextScopes = scopes.flatMap((scope): AttentionScopeRow[] => {
    const floor = floors.get(scope.scopeId)
    const ordinaryUnread = scope.ordinaryUnread && (!floor || scope.lastUnreadSeq > floor.ordinary)
    const lastAttentionSeq = floor && (scope.lastAttentionSeq ?? -1) <= floor.mentions ? null : scope.lastAttentionSeq
    const cleared = floor?.mentions !== undefined && floor.mentions >= 0 ? floor.cleared : 0
    const remaining = lastAttentionSeq === null ? 0 : Math.max(
      survivingByScope.get(scope.scopeId) ?? 0,
      scope.attentionCount - cleared,
    )
    const attentionCount = Math.max(0, Math.min(scope.attentionCount, remaining) - (removedByScope.get(scope.scopeId) ?? 0))
    if (!ordinaryUnread && attentionCount === 0) return []
    return [{ ...scope, ordinaryUnread, lastAttentionSeq: attentionCount === 0 ? null : lastAttentionSeq, attentionCount }]
  })
  return { scopes: nextScopes, items: nextItems }
}

function rebaseAttentionTransactions(registry: CommunityDbRegistry) {
  const store = attentionTransactionStores.get(registry)
  if (!store || store.get().rebasing) return
  store.setState((state) => ({ ...state, rebasing: true }))
  try {
    const terminal = new Set<symbol>()
    for (const [token, transaction] of store.get().transactions) {
      if (transaction.state === "completed" || transaction.state === "failed") {
        terminal.add(token)
        store.get().intents.get(token)?.resolveSettled(transaction.state === "completed")
      } else transaction.rollback({ isSecondaryRollback: true })
    }
    const intents = new Map([...store.get().intents].filter(([token, intent]) => !terminal.has(token) && attentionIntentActive(registry, intent)))
    for (const [token, intent] of store.get().intents) if (!intents.has(token) && !terminal.has(token)) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
    const transactions = new Map<symbol, AttentionTransaction>()
    store.setState((state) => ({ ...state, intents, transactions }))
    if (registry.collections.attentionScopes.status !== "ready" || registry.collections.attentionItems.status !== "ready") {
      if (!store.get().preload && intents.size > 0) {
        const original = store
        const preload = Promise.all([registry.collections.attentionScopes.preload(), registry.collections.attentionItems.preload()]).then(() => {
          if (attentionTransactionStores.get(registry) !== original) return
          original.setState((state) => ({ ...state, preload: null }))
          rebaseAttentionTransactions(registry)
        }, () => {
          if (attentionTransactionStores.get(registry) !== original) return
          for (const intent of original.get().intents.values()) { intent.resolveOutcome(undefined); intent.resolveSettled(false) }
          original.setState((state) => ({ ...state, intents: new Map(), transactions: new Map(), preload: null }))
        })
        original.setState((state) => ({ ...state, preload }))
      }
      return
    }
    const scopes = collectionRows(registry, "attentionScopes")
    const items = collectionRows(registry, "attentionItems")
    const prefix: AttentionIntent[] = []
    for (const intent of intents.values()) {
      prefix.push(intent)
      const projected = attentionProjection(registry, scopes, items, prefix)
      const persist = async () => {
        const committed = await intent.outcome
        if (!committed || store.get().transactions.get(intent.token) !== transaction || !attentionIntentActive(registry, intent)) return
        store.setState((state) => ({ ...state, rebasing: true }))
        try { publishAttentionConfirmation(registry, store.get().intents.get(intent.token) ?? intent, committed) }
        catch {
          transaction.rollback({ isSecondaryRollback: true })
          finishAttentionTransaction(registry, intent, transaction, false)
        } finally { store.setState((state) => ({ ...state, rebasing: false })) }
      }
      const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      void transaction.when("settled").catch(() => undefined)
      transaction.mutate(() => {
        const nextScopes = new Map(projected.scopes.map((scope) => [scope.scopeId, scope]))
        for (const scope of registry.collections.attentionScopes.values()) {
          const next = nextScopes.get(scope.scopeId)
          if (!next) registry.collections.attentionScopes.delete(scope.scopeId)
          else if (Object.entries(next).some(([key, value]) => (scope as unknown as Record<string, unknown>)[key] !== value)) registry.collections.attentionScopes.update(scope.scopeId, (draft) => Object.assign(draft, next))
        }
        const nextIds = new Set(projected.items.map((item) => item.id))
        for (const item of registry.collections.attentionItems.values()) if (!nextIds.has(item.id)) registry.collections.attentionItems.delete(item.id)
      })
      transactions.set(intent.token, transaction)
    }
    store.setState((state) => ({ ...state, transactions }))
    for (const intent of intents.values()) {
      const transaction = transactions.get(intent.token)!
      if (transaction.mutations.length > 0) {
        void transaction.commit().then(() => finishAttentionTransaction(registry, intent, transaction, transaction.state === "completed"), () => finishAttentionTransaction(registry, intent, transaction, false))
      } else {
        void intent.outcome.then((committed) => {
          if (!committed || store.get().transactions.get(intent.token) !== transaction || !attentionIntentActive(registry, intent)) return
          store.setState((state) => ({ ...state, rebasing: true }))
          try { publishAttentionConfirmation(registry, store.get().intents.get(intent.token) ?? intent, committed) }
          finally { store.setState((state) => ({ ...state, rebasing: false })) }
          return transaction.commit().then(() => finishAttentionTransaction(registry, intent, transaction, true))
        }).catch(() => finishAttentionTransaction(registry, intent, transaction, false))
      }
    }
  } finally {
    store.setState((state) => ({ ...state, rebasing: false }))
  }
}

function beginAttentionIntent(registry: CommunityDbRegistry, values: Pick<AttentionIntent, "floors" | "itemIds" | "itemDomains" | "scopeId" | "targetSeq" | "clearedAttentionCount">) {
  const store = attentionTransactionStore(registry)
  let resolveOutcome!: AttentionIntent["resolveOutcome"], resolveSettled!: AttentionIntent["resolveSettled"]
  const outcome = new Promise<ReadonlySet<AttentionDomain> | undefined>((resolve) => { resolveOutcome = resolve })
  const settled = new Promise<boolean>((resolve) => { resolveSettled = resolve })
  const intent: AttentionIntent = {
    ...values, outcome, resolveOutcome, settled, resolveSettled, token: Symbol("attention-command"), generation: registry.runtime.lifecycle.get().generation,
    scopesQuery: registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionScopes"), exact: true }),
    itemsQuery: registry.queryClient.getQueryCache().find({ queryKey: communityKeys.communityDbCollection(registry.scopeId, "attentionItems"), exact: true }),
  }
  notifyManager.batch(() => {
    store.setState((state) => ({ ...state, intents: new Map(state.intents).set(intent.token, intent) }))
    rebaseAttentionTransactions(registry)
  })
  return intent
}

function publishAttentionConfirmation(registry: CommunityDbRegistry, current: AttentionIntent, committed: ReadonlySet<AttentionDomain>) {
  const floors = new Map([...current.floors].map(([id, floor]) => [id, {
    ...floor,
    ordinary: floor.ordinary && committed.has(floor.domain),
    mentions: floor.mentions && committed.has(floor.domain === "dms" ? "dms" : "mentions"),
  }]))
  const confirmed = { ...current, floors, itemIds: new Set([...current.itemIds].filter((id) => committed.has(current.itemDomains.get(id) ?? "mentions"))) }
  const scopes = collectionRows(registry, "attentionScopes")
  const items = collectionRows(registry, "attentionItems")
  const projected = attentionProjection(registry, scopes, items, [confirmed])
  const nextScopes = new Map(projected.scopes.map((scope) => [scope.scopeId, scope]))
  const previousScopes = new Map(scopes.map((scope) => [scope.scopeId, scope]))
  const nextItems = new Set(projected.items.map((item) => item.id))
  const removedScopes = new Set(scopes.filter((scope) => !nextScopes.has(scope.scopeId)).map((scope) => scope.scopeId))
  const removedItems = new Set(items.filter((item) => !nextItems.has(item.id)).map((item) => item.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => {
    if (removedScopes.size) deleteRows(registry, "attentionScopes", (row) => removedScopes.has(row.scopeId))
    upsertRows(registry, "attentionScopes", projected.scopes.filter((scope) => JSON.stringify(scope) !== JSON.stringify(previousScopes.get(scope.scopeId))))
    if (removedItems.size) deleteRows(registry, "attentionItems", (row) => removedItems.has(row.id))
  })
  const store = attentionTransactionStores.get(registry)
  store?.setState((state) => ({ ...state, intents: new Map([...state.intents].map(([token, intent]) => {
    if (token === current.token) return [token, intent]
    const remaining = new Map([...intent.floors].map(([id, floor]) => {
      const applied = floors.get(id)
      if (!applied?.mentions || !floor.mentions) return [id, floor]
      const removed = Math.max(0, (previousScopes.get(id)?.attentionCount ?? 0) - (nextScopes.get(id)?.attentionCount ?? 0))
      return [id, { ...floor, clearedCount: applied.throughSeq >= floor.throughSeq ? 0 : Math.max(0, floor.clearedCount - removed) }]
    }))
    return [token, { ...intent, floors: remaining }]
  })) }))
}

function finishAttentionTransaction(registry: CommunityDbRegistry, intent: AttentionIntent, transaction: AttentionTransaction, success: boolean) {
  const store = attentionTransactionStores.get(registry)
  if (!store || store.get().transactions.get(intent.token) !== transaction) return
  notifyManager.batch(() => {
    store.setState((state) => {
      const intents = new Map(state.intents), transactions = new Map(state.transactions)
      intents.delete(intent.token)
      transactions.delete(intent.token)
      return { ...state, intents, transactions }
    })
    intent.resolveSettled(success)
    rebaseAttentionTransactions(registry)
  })
}

function settleAttentionIntent(registry: CommunityDbRegistry, intent: AttentionIntent, committed?: ReadonlySet<AttentionDomain>) {
  const store = attentionTransactionStores.get(registry)
  const current = store?.get().intents.get(intent.token)
  if (!store || !current || !attentionIntentActive(registry, current)) { intent.resolveSettled(false); return false }
  if (committed) {
    current.resolveOutcome(committed)
    return true
  }
  const transaction = store.get().transactions.get(intent.token)
  if (transaction?.state === "completed" || transaction?.state === "failed") {
    finishAttentionTransaction(registry, current, transaction, transaction.state === "completed")
    return false
  }
  const superseded = current.scopeId && [...store.get().intents.values()].some((other) => other.token !== current.token && other.scopeId === current.scopeId && (other.targetSeq ?? -1) >= (current.targetSeq ?? -1))
  notifyManager.batch(() => {
    store.setState((state) => ({ ...state, rebasing: true }))
    try {
      store.get().transactions.get(intent.token)?.rollback({ isSecondaryRollback: true })
      store.setState((state) => {
        const intents = new Map(state.intents), transactions = new Map(state.transactions)
        intents.delete(intent.token)
        transactions.delete(intent.token)
        return { ...state, intents, transactions }
      })
      current.resolveOutcome(undefined)
      current.resolveSettled(false)
    } finally { store.setState((state) => ({ ...state, rebasing: false })) }
    rebaseAttentionTransactions(registry)
  })
  return !superseded
}

export function hasAttentionScopeOptimisticFence(queryClient: QueryClient, scopeId: string, targetSeq: number) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return [...(attentionTransactionStores.get(registry)?.get().intents.values() ?? [])]
    .some((intent) => intent.scopeId === scopeId && (intent.targetSeq ?? -1) >= targetSeq)
}

export function ingestAttentionSnapshot(registry: CommunityDbRegistry, snapshot: AccountAttentionSnapshot) {
  notifyManager.batch(() => {
    const pending = collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" && row.needsOwnerApproval == null)
    const blocked = new Set(collectionRows(registry, "friendships").filter((row) => row.kind === "blocked").map((row) => row.userId))
    ingestAttentionIncluded(registry, snapshot.included)
    replaceRows(registry, "attentionScopes", snapshot.scopes, () => true)
    replaceRows(registry, "attentionItems", snapshot.items.filter((row) => row.kind !== "friend_request" || !row.actorUserId || (!blocked.has(row.actorUserId) && !isProtectedFromQueryWrite(registry, "friendships", `user:${row.actorUserId}`))), () => true)
    const requests = collectionRows(registry, "attentionItems").filter((row) => row.kind === "friend_request" && row.actorUserId)
    upsertRows(registry, "friendships", requests.filter((row) => !blocked.has(row.actorUserId!)).map((row) => ({ id: row.sourceId, userId: row.actorUserId!, kind: "incoming" as const })))
    if (!snapshot.truncated) retireCanonicalFriendRequests(registry, pending.filter((row) => !requests.some((item) => item.sourceId === row.id)).map((row) => row.id))
    rebaseAttentionTransactions(registry)
  })
  return "applied" as const
}

export type AttentionOptimisticSnapshot = AttentionIntent
export type AttentionScopeOptimisticSnapshot = AttentionIntent & { scopeId: string; targetSeq: number }
export type AttentionItemsOptimisticSnapshot = AttentionIntent

export function clearAttentionOptimistically(registry: CommunityDbRegistry): AttentionOptimisticSnapshot {
  const floors = new Map(collectionRows(registry, "attentionScopes").map((scope) => [scope.scopeId, {
    throughSeq: Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0),
    clearedCount: scope.attentionCount, domain: scope.serverId == null ? "dms" as const : "channels" as const,
    ordinary: true, mentions: true,
  }]))
  const items = collectionRows(registry, "attentionItems").filter((item) => item.kind !== "friend_request")
  return beginAttentionIntent(registry, { floors, itemIds: new Set(items.map((item) => item.id)), itemDomains: new Map(items.map((item) => [item.id, "mentions" as const])), clearedAttentionCount: 0 })
}

export function commitAttentionOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionOptimisticSnapshot) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionOptimisticDomains(registry: CommunityDbRegistry, snapshot: AttentionOptimisticSnapshot, failedDomains: ReadonlySet<AttentionDomain>) {
  settleAttentionIntent(registry, snapshot, new Set((["channels", "dms", "mentions"] as const).filter((domain) => !failedDomains.has(domain))))
  return snapshot.settled
}
export function restoreAttentionOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionOptimisticSnapshot) {
  return settleAttentionIntent(registry, snapshot)
}

export function clearAttentionScopeOptimistically(registry: CommunityDbRegistry, scopeId: string, targetSeq: number): AttentionScopeOptimisticSnapshot {
  const scope = collectionRows(registry, "attentionScopes").find((row) => row.scopeId === scopeId)
  const messages = new Map(collectionRows(registry, "messages").map((message) => [message.id, message]))
  const items = collectionRows(registry, "attentionItems").filter((item) => item.scopeId === scopeId)
  const seqOf = (item: AttentionItemRow) => item.readTarget?.seq ?? item.openerSeq ?? (item.messageId ? messages.get(item.messageId)?.seq : undefined)
  const removed = items.filter((item) => (seqOf(item) ?? scope?.lastUnreadSeq ?? 0) <= targetSeq)
  const surviving = items.filter((item) => (item.kind === "mention" || item.kind === "reply") && (seqOf(item) ?? -1) > targetSeq).length
  const clearedAttentionCount = Math.max(0, (scope?.attentionCount ?? 0) - surviving)
  return beginAttentionIntent(registry, {
    scopeId, targetSeq, clearedAttentionCount,
    floors: new Map([[scopeId, { throughSeq: targetSeq, clearedCount: clearedAttentionCount, domain: scope?.serverId == null ? "dms" : "channels", ordinary: true, mentions: true }]]),
    itemIds: new Set(removed.map((item) => item.id)), itemDomains: new Map(removed.map((item) => [item.id, "mentions" as const])),
  }) as AttentionScopeOptimisticSnapshot
}
export function commitAttentionScopeOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionScopeOptimisticSnapshot) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionScopeOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionScopeOptimisticSnapshot) {
  return settleAttentionIntent(registry, snapshot)
}

export function removeAttentionItemsOptimistically(registry: CommunityDbRegistry, remove: (item: AttentionItemRow) => boolean): AttentionItemsOptimisticSnapshot {
  const items = collectionRows(registry, "attentionItems").filter(remove)
  return beginAttentionIntent(registry, { floors: new Map(), itemIds: new Set(items.map((item) => item.id)), itemDomains: new Map(items.map((item) => [item.id, "mentions" as const])), clearedAttentionCount: 0 })
}
export function commitAttentionItemsOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionItemsOptimisticSnapshot) {
  settleAttentionIntent(registry, snapshot, new Set(["channels", "dms", "mentions"]))
  return snapshot.settled
}
export function restoreAttentionItemsOptimisticSnapshot(registry: CommunityDbRegistry, snapshot: AttentionItemsOptimisticSnapshot) {
  return settleAttentionIntent(registry, snapshot)
}

function ingestNotificationSettings(
  registry: CommunityDbRegistry,
  settings: NotificationSettings,
  mode: SnapshotIngestMode = "authoritative",
) {
  const rows: NotificationSettingRow[] = settings.raw.flatMap((row) => {
    if (Boolean(row.serverId) === Boolean(row.channelId)) return []
    const target = { serverId: row.serverId ?? null, channelId: row.channelId ?? null }
    return [{ id: notificationSettingKey(target), ...target, level: row.level }]
  })
  if (mode === "authoritative") {
    replaceRows(
      registry,
      "notificationSettings",
      rows,
      () => true,
    )
  } else {
    upsertRows(
      registry,
      "notificationSettings",
      rows,
    )
  }
}

export type CommunityLiveSnapshot =
  | { kind: "servers"; data: ServersResponse }
  | { kind: "server-detail"; data: ServerDetail }
  | { kind: "folders"; data: FoldersResponse }
  | { kind: "dms"; data: DmsResponse }
  | { kind: "read-state"; data: AccountReadStateSnapshot }
  | { kind: "notification-settings"; data: NotificationSettings }

declare const communityLiveSnapshotTokenBrand: unique symbol

export type CommunityLiveSnapshotToken = {
  readonly viewerId: string | null
  readonly accountEpoch: number
  readonly accessEpoch: number
  readonly channelId?: string
  readonly channelLineage?: Pick<ChannelRow, "parentChannelId">
  readonly channelScopes: ReturnType<ReturnType<typeof getCommunityRuntime>["ws"]["get"]>["channelAccessScopes"]
  readonly profileSnapshot: CommunityProfileSeedSnapshot
  readonly canonicalRevision: number
  readonly queryClient: QueryClient
  readonly registry: CommunityDbRegistry | null
  readonly ownerGeneration: number
  readonly [communityLiveSnapshotTokenBrand]: true
}

type StructuralCommunityLiveSnapshot = Exclude<CommunityLiveSnapshot, { kind: "read-state" }>

type CommunityLiveSnapshotPublication =
  | {
      snapshot: StructuralCommunityLiveSnapshot
      proof: {
        kind: "structural"
        token: CommunityLiveSnapshotToken
        signal: AbortSignal | undefined
      }
    }
  | {
      snapshot: Extract<CommunityLiveSnapshot, { kind: "read-state" }>
      proof: {
        kind: "read-state"
        token: CommunityLiveSnapshotToken
        signal: AbortSignal | undefined
        requestGeneration: number
        currentRequestGeneration: number
        targetRevision: number | null
      }
    }

export type CommunityFreshQueryProof = {
  token: CommunityLiveSnapshotToken
  signal?: AbortSignal
}

export function publishCommunityMembersSnapshot(queryClient: QueryClient, serverId: string, members: readonly { id: string; userId: string; role: string }[], proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    const previous = new Map(collectionRows(registry, "serverMemberships").map((row) => [row.id, row]))
    upsertRows(registry, "serverMemberships", members.map((member) => {
      const id = serverMembershipKey(serverId, member.userId)
      return { ...previous.get(id), id, serverId, userId: member.userId, memberId: member.id, role: member.role, viewer: member.userId === registry.accountId }
    }))
  })
}

function withCommunityQueryProof<T>(queryClient: QueryClient, proof: CommunityFreshQueryProof, publish: (registry: CommunityDbRegistry) => T): T {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  return withCanonicalWriteContext(queryClient, { kind: "query", requestRevision: proof.token.canonicalRevision, profileSnapshot: proof.token.profileSnapshot }, () => publish(proof.token.registry!))
}

function ingestResourceProfiles(registry: CommunityDbRegistry, profiles: readonly CommunityResourceProfile[], proof: CommunityFreshQueryProof) {
  writeCommunityProfilePatches(profiles.map((profile) => communityUserProfilePatch(profile.id, { ...profile, discriminator: profile.discriminator ?? "", avatar: profile.avatar ?? avatarInitial(profile.name) })), registry, { snapshot: proof.token.profileSnapshot })
}

export function publishCommunityChannelMembersSnapshot(queryClient: QueryClient, serverId: string | null, channelId: string, relation: CommunityMemberRelation["relation"], members: readonly CommunityMemberRelation[], proof: CommunityFreshQueryProof, profiles: readonly CommunityResourceProfile[] = []) {
  if (serverId) publishCommunityMembersSnapshot(queryClient, serverId, members.flatMap((member) => member.role === null || member.memberId === null ? [] : [{ ...member, id: member.memberId, role: member.role }]), proof)
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    ingestResourceProfiles(registry, profiles, proof)
    replaceRows(registry, "channelMemberships", members.map((member) => channelMembershipSchema.parse({ ...member, id: channelMembershipKey(channelId, member.userId, relation), memberId: member.memberId ?? undefined })), (row) => row.channelId === channelId && row.relation === relation)
  })
}

export function publishCommunityMemberRole(queryClient: QueryClient, memberKey: string, memberId: string, role: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const row = collectionRows(proof.token.registry!, "serverMemberships").find((row) => row.id === memberKey)
  if (!row || row.memberId !== memberId) return false
  return publishConfirmedFields(queryClient, "serverMemberships", memberKey, { role }, proof)
}

export function publishCommunityMemberRemoval(queryClient: QueryClient, memberKey: string, memberId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  if (!collectionRows(registry, "serverMemberships").some((row) => row.id === memberKey && row.memberId === memberId)) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    deleteRows(registry, "serverMemberships", (row) => row.id === memberKey && row.memberId === memberId, [memberKey])
    return true
  })
}

export function captureCommunityLiveSnapshotToken(
  queryClient: QueryClient,
  channelId?: string,
): CommunityLiveSnapshotToken {
  const state = getCommunityRuntime(queryClient).ws.get()
  const registry = getCommunityDbRegistry(queryClient)
  const row = channelId ? registry?.collections.channels.get(channelId) : undefined
  const scope = channelId ? state.channelAccessScopes.get(channelId) : undefined
  const parentChannelId = row?.parentChannelId ?? scope?.parentChannelId
  const lineageKnown = !!row && (row.type !== "thread" || !!parentChannelId) || scope?.serverId === null || !!parentChannelId
  return {
    channelLineage: lineageKnown ? { parentChannelId } : undefined,
    viewerId: state.profileViewerId,
    accountEpoch: state.profileAccountEpoch,
    accessEpoch: state.accessEpoch,
    channelId,
    channelScopes: state.channelAccessScopes,
    canonicalRevision: canonicalRevisionState(queryClient).revision,
    profileSnapshot: beginCommunityProfileSeed(getCommunityDbRegistry(queryClient)),
    queryClient,
    registry: getCommunityDbRegistry(queryClient),
    ownerGeneration: getCommunityRuntime(queryClient).lifecycle.get().generation,
  } as CommunityLiveSnapshotToken
}

export function assertCommunityLiveSnapshotTokenCurrent(
  queryClient: QueryClient,
  token: CommunityLiveSnapshotToken,
  signal: AbortSignal | undefined,
) {
  const state = getCommunityRuntime(queryClient).ws.get()
  if (
    signal?.aborted
    || !token.registry?.runtime.lifecycle.get().active
    || token.registry.runtime.lifecycle.get().generation !== token.ownerGeneration
    || state.profileViewerId !== token.viewerId
    || state.profileAccountEpoch !== token.accountEpoch
    || state.accessEpoch !== token.accessEpoch
    || (token.channelId && token.channelLineage
      ? [token.channelId, token.channelLineage.parentChannelId].some((id) => id && (state.channelAccessScopes.get(id)?.generation ?? 0) !== (token.channelScopes.get(id)?.generation ?? 0))
      : [...state.channelAccessScopes].some(([id, scope]) => scope.generation !== (token.channelScopes.get(id)?.generation ?? 0)))
    || queryClient !== token.queryClient
    || getCommunityDbRegistry(queryClient) !== token.registry
  ) throw new DOMException("Stale community live snapshot", "AbortError")
}

export function beginCommunityCommandRevision(queryClient: QueryClient, token: CommunityLiveSnapshotToken): CommunityLiveSnapshotToken {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, token, undefined)
  return { ...token, canonicalRevision: canonicalRevisionState(queryClient).revision }
}

/**
 * Publishes a newly settled live snapshot into the canonical DB.
 *
 * This is the only query-owned path allowed to replace or delete canonical
 * rows. Hydrated or manually written transport caches are never DB inputs;
 * only the fresh queryFn that owns this proof may publish its response.
 */
export function publishCommunityLiveSnapshot(
  queryClient: QueryClient,
  publication: CommunityLiveSnapshotPublication,
) {
  const { proof, snapshot } = publication
  return withCommunityQueryProof(queryClient, proof, (registry) => {
    if (proof.kind === "read-state") {
      if (
        proof.requestGeneration !== proof.currentRequestGeneration
        || (
          proof.targetRevision !== null
          && (snapshot as Extract<CommunityLiveSnapshot, { kind: "read-state" }>).data.revision
            < proof.targetRevision
        )
      ) return "superseded" as const
    }
    switch (snapshot.kind) {
      case "servers":
        ingestServers(registry, snapshot.data)
        break
      case "server-detail":
        ingestServerDetail(registry, snapshot.data)
        qualifyCanonicalChannelMetadata(registry,
          snapshot.data.categories.flatMap((category) => category.channels.map((channel) => channel.id)), proof.token)
        break
      case "folders":
        ingestFolders(registry, snapshot.data)
        break
      case "dms":
        ingestDms(registry, snapshot.data)
        qualifyCanonicalChannelMetadata(registry, snapshot.data.conversations.map((dm) => dm.id), proof.token)
        break
      case "read-state":
        ingestReadStateSnapshot(registry, snapshot.data)
        break
      case "notification-settings":
        ingestNotificationSettings(registry, snapshot.data)
        break
    }
    return "published" as const
  })
}

export function publishAccountAttentionSnapshot(
  queryClient: QueryClient,
  publication: {
    snapshot: AccountAttentionSnapshot
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    ingestAttentionSnapshot(registry, publication.snapshot)
    return "published" as const
  })
}

/** Merge confirmed rows from one fresh transport response into canonical DB. */
export function publishCommunityMessages(
  queryClient: QueryClient,
  publication: {
    channelId: string
    messages: Msg[]
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    ingestMessages(registry, publication.channelId, publication.messages)
    return "published" as const
  })
}

/** Publish message entities embedded in a cross-scope transport response. */
export function publishCommunityEmbeddedMessages(
  queryClient: QueryClient,
  publication: {
    entries: Array<{ channelId: string; message: MessageInput | CommunityMessageResource }>
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    const byChannel = new Map<string, Array<MessageInput | CommunityMessageResource>>()
    for (const { channelId, message } of publication.entries) {
      byChannel.set(channelId, [...(byChannel.get(channelId) ?? []), message])
    }
    notifyManager.batch(() => {
      for (const [channelId, messages] of byChannel) {
        ingestMessages(registry, channelId, messages)
      }
    })
    return "published" as const
  })
}

export type CommunityChannelMetadata = CommunityChannelIdentity

function qualifyCanonicalChannelMetadata(registry: CommunityDbRegistry, channelIds: readonly string[], token: CommunityLiveSnapshotToken) {
  if (!registry.accountId) return
  for (const channelId of channelIds) {
    const channel = registry.collections.channels.get(channelId)
    const membership = registry.collections.channelMemberships.get(channelMembershipKey(channelId, registry.accountId, "access"))
    if (!channel || channel.pending || channel.archived || !membership) continue
    registry.queryClient.setQueryData(communityKeys.channelMeta(channel.serverId ?? null, channelId), (previous: { readProof?: unknown } | undefined) => ({
      id: channel.id,
      serverId: channel.serverId ?? null,
      identityProof: { ...token, channelId },
      readProof: previous?.readProof,
    }))
  }
}

/** Publish one verified channel metadata response and its viewer access fact. */
export function publishCommunityChannelMetadata(
  queryClient: QueryClient,
  publication: {
    metadata: CommunityChannelMetadata
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    ingestChannelMetadata(registry, publication.metadata, publication.proof)
    const viewerId = registry.accountId
    if (viewerId) {
      upsertRows(
        registry,
        "channelMemberships",
        [canonicalChannelMembershipRow(publication.metadata.id, viewerId, "access", { source: "explicit" })],
      )
    }
    return "published" as const
  })
}

/** Merge the fresh all-server ref directory without degrading known rows. */
export function publishCommunityChannelDirectory(
  queryClient: QueryClient,
  publication: {
    directory: ChannelRefDirectory
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
  const existingChannels = new Map(
    collectionRows(registry, "channels").map((row) => [row.id, row]),
  )
  const viewerId = registry.accountId
  const servers = serverSummaryRows(registry, publication.directory)
  const channels: ChannelRow[] = publication.directory.flatMap((server) => (
    server.channels.flatMap((channel, position) => {
      const existing = existingChannels.get(channel.id)
      // Older directory payloads predate the subtype field and therefore only
      // describe text channels. Preserve any richer canonical subtype first.
      const type = channel.type ?? existing?.type ?? "text"
      return [canonicalChannelRow({
        id: channel.id, serverId: server.id, name: channel.name, type,
        parentChannelId: null, parentMessageId: null, position: existing?.position ?? position,
      }, existing)]
    })
  ))
  notifyManager.batch(() => {
    upsertRows(registry, "servers", servers)
    upsertRows(registry, "channels", channels)
    if (viewerId) {
      seedViewerServerMemberships(registry, servers)
      upsertRows(
        registry,
        "channelMemberships",
        channels.map((channel) => (canonicalChannelMembershipRow(channel.id, viewerId, "access", { source: "inherited" as const }))),
      )
    }
  })
    return "published" as const
  })
}

export type CommunityForumSidebarChannel = Pick<CommunityChannelIdentity, "id" | "parentChannelId" | "parentMessageId"> & Partial<Pick<CommunityChannelIdentity, "creatorId" | "lastMessageAt">> & {
  name: NonNullable<CommunityChannelIdentity["name"]>
  serverId?: NonNullable<CommunityChannelIdentity["serverId"]>
  type?: string
  archived?: CommunityChannelIdentity["archived"] | number
  activityAt: string
  unread: boolean
  participating?: boolean
}

export type CommunityForumSidebarOpener = Pick<CommunityMessageResource, "id" | "content"> & Partial<Pick<CommunityMessageResource, "seq" | "channelId" | "type">>

/** Publish the service facts carried by one forum-sidebar response. */
export function publishCommunityForumSidebar(
  queryClient: QueryClient,
  publication: {
    serverId: string
    channels: CommunityForumSidebarChannel[]
    openers: CommunityForumSidebarOpener[]
    negativeRetain?: {
      id: string
      disposition: "opener-archived" | "genuine-negative"
    } | null
    proof: CommunityFreshQueryProof
  },
) {
  return withCommunityQueryProof(queryClient, publication.proof, (registry) => {
    const existingById = new Map(
    collectionRows(registry, "channels").map((row) => [row.id, row]),
  )
  const channels: ChannelRow[] = publication.channels.flatMap((channel) => {
    if (!channel.parentChannelId || !channel.parentMessageId) return []
    const existing = existingById.get(channel.id)
    return [canonicalChannelRow({
      id: channel.id,
      serverId: channel.serverId ?? publication.serverId,
      name: channel.name,
      type: "thread" as const,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      creatorId: channel.creatorId ?? existing?.creatorId ?? null,
      archived: channel.archived === true || channel.archived === 1,
      unread: channel.unread,
      lastMessageAt: channel.lastMessageAt ?? channel.activityAt,
    }, existing)]
  })
  const viewerId = registry.accountId
  notifyManager.batch(() => {
    upsertRows(registry, "channels", channels)
    for (const channel of publication.channels) {
      if (channel.participating === false || channel.archived === true || channel.archived === 1) continue
      const current = collectionRows(registry, "channels")
        .find((row) => row.id === channel.id && row.serverId === publication.serverId && row.type === "thread")
      if (current?.tags.includes(FORUM_ARCHIVE_TAG)) {
        publishConfirmedFields(queryClient, "channels", channel.id, {
          tags: current.tags.filter((tag) => tag !== FORUM_ARCHIVE_TAG),
        }, publication.proof)
      }
    }
    if (viewerId) {
      upsertRows(
        registry,
        "channelMemberships",
        channels.map((channel) => (canonicalChannelMembershipRow(channel.id, viewerId, "access", { source: "explicit" as const }))),
      )
      const participating = publication.channels
        .filter((channel) => channel.participating !== false)
        .map((channel) => channel.id)
      upsertRows(
        registry,
        "channelMemberships",
        participating.map((channelId) => (canonicalChannelMembershipRow(channelId, viewerId, "notify", { source: "explicit" as const }))),
      )
    }
    for (const opener of publication.openers) {
      const channelId = opener.channelId
        ?? channels.find((channel) => channel.parentMessageId === opener.id)?.parentChannelId
      if (!channelId) continue
      ingestMessages(registry, channelId, [{
        ...opener,
        type: opener.type ?? "chat",
      } as Msg])
    }
    if (publication.negativeRetain) {
      const { id, disposition } = publication.negativeRetain
      if (disposition === "opener-archived") {
        const current = collectionRows(registry, "channels")
          .find((row) => row.id === id)
        if (!current) {
          upsertRows(registry, "channels", [canonicalChannelRow({ id, serverId: publication.serverId, type: "thread", pending: true })])
        }
        const target = collectionRows(registry, "channels")
          .find((row) => row.id === id && row.serverId === publication.serverId && row.type === "thread")
        if (target && !target.tags.includes(FORUM_ARCHIVE_TAG)) {
          publishConfirmedFields(queryClient, "channels", id, {
            tags: [...target.tags, FORUM_ARCHIVE_TAG],
          }, publication.proof)
        }
      }
      deleteRows(
        registry,
        "channelMemberships",
        (row) => row.channelId === id
          && row.userId === viewerId
          && row.relation === "notify",
      )
      if (disposition === "genuine-negative") {
        patchRows(
          registry,
          "channels",
          (row) => ({ ...row, unread: false }),
          (row) => row.id === id,
        )
      }
    }
    qualifyCanonicalChannelMetadata(registry, channels.map((channel) => channel.id), publication.proof.token)
  })
    return "published" as const
  })
}

export function patchCanonicalCommunityChannel(
  queryClient: QueryClient,
  channelId: string,
  patch: (row: ChannelRow) => ChannelRow,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => patchRows(
    registry,
    "channels",
    patch,
    (row) => row.id === channelId,
  ))
}

export function publishCommunityChannelPatch(
  queryClient: QueryClient,
  channelId: string,
  patch: (row: ChannelRow) => ChannelRow,
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const row = collectionRows(registry, "channels").find((row) => row.id === channelId)
  if (!row) return false
  const next = patch(row)
  const changes = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.is(value, row[key as keyof ChannelRow])))
  return publishConfirmedFields(queryClient, "channels", channelId, changes, proof)
}

function publishConfirmedFields<N extends CollectionName>(
  queryClient: QueryClient,
  name: N,
  id: string,
  changes: Partial<CommunityCollectionRows[N]>,
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const getKey = collectionKey(registry, name)
  if (!collectionRows(registry, name).some((row) => getKey(row) === id)) return false
  const revisions = canonicalRevisionState(queryClient).fieldRevisions.get(canonicalEntityKey(name, id))
  const fields = Object.keys(changes).filter((field) => (
    changes[field as keyof CommunityCollectionRows[N]] !== undefined
    && (revisions?.get("*") ?? 0) <= proof.token.canonicalRevision
    && (revisions?.get(field) ?? 0) <= proof.token.canonicalRevision
  ))
  if (!fields.length) return false
  const accepted = Object.fromEntries(fields.map((field) => [field, changes[field as keyof CommunityCollectionRows[N]]]))
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => (
    patchRows(registry, name, (row) => ({ ...row, ...accepted }), (row) => getKey(row) === id, [id], fields)
  ))
}

export function publishCommunityServerFields(
  queryClient: QueryClient,
  serverId: string,
  changes: Partial<Pick<ServerRow, "name" | "description" | "icon">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "servers", serverId, changes, proof)
}

export function publishCommunityChannelFields(
  queryClient: QueryClient,
  channelId: string,
  changes: Partial<Pick<ChannelRow, "name" | "categoryId" | "position">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "channels", channelId, changes, proof)
}

export function publishCommunityCategoryFields(
  queryClient: QueryClient,
  categoryId: string,
  changes: Partial<Pick<CategoryRow, "name" | "position">>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "categories", categoryId, changes, proof)
}

export function publishCommunityMessageFields(
  queryClient: QueryClient,
  messageId: string,
  changes: Partial<MessageRow>,
  proof: CommunityFreshQueryProof,
) {
  return publishConfirmedFields(queryClient, "messages", messageId, changes, proof)
}

export function publishCommunityMessageReaction(queryClient: QueryClient, messageId: string, emoji: string, userId: string, add: boolean, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const state = canonicalRevisionState(queryClient), registry = proof.token.registry!, field = `reaction:${emoji}:${userId}`
  const revisions = state.fieldRevisions.get(canonicalEntityKey("messages", messageId))
  if ((revisions?.get("*") ?? 0) > proof.token.canonicalRevision || (revisions?.get(field) ?? 0) > proof.token.canonicalRevision) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => patchRows(registry, "messages", (row) => ({
    ...row, reactions: applyMessageReaction((row as MessageRow & Msg).reactions, emoji, userId, add, registry.accountId || null),
  }), (row) => row.id === messageId, [messageId], ["reactions", field]))
}

export function publishCommunityForumFeed(queryClient: QueryClient, forumChannelId: string, page: CommunityThreadResources, proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => notifyManager.batch(() => {
    const rows = page.threads.map((thread) => canonicalChannelRow({
      ...thread, type: "thread", serverId: page.channel.serverId, parentChannelId: forumChannelId,
      name: thread.name ?? "Post", pending: false,
      tags: page.included.tags.filter((tag) => tag.messageId === thread.parentMessageId).map((tag) => tag.tag),
      lastMessageAt: thread.lastMessageAt ?? thread.createdAt,
      preview: page.included.previews.find((message) => message.channelId === thread.id)?.content.slice(0, 100) ?? "",
      participantCount: page.included.participantCounts.find((row) => row.channelId === thread.id)?.count ?? 0,
    }, registry.collections.channels.get(thread.id)))
    upsertRows(registry, "channels", rows)
    ingestResourceProfiles(registry, page.included.profiles, proof)
    publishCommunityEmbeddedMessages(queryClient, { entries: page.included.messages.map((message) => ({ channelId: message.channelId, message })), proof })
    upsertRows(registry, "channelMemberships", page.included.members.map((member) => channelMembershipSchema.parse({ ...member, id: channelMembershipKey(member.channelId, member.userId, member.relation), memberId: member.memberId ?? undefined })))
  }))
}

export function publishCommunityForumTags(queryClient: QueryClient, threadId: string, tags: string[], proof: CommunityFreshQueryProof) {
  return publishConfirmedFields(queryClient, "channels", threadId, { tags }, proof)
}

export function publishCommunityNotificationSetting(queryClient: QueryClient, target: Pick<NotificationSettingRow, "serverId" | "channelId">, level: string | null, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!, id = notificationSettingKey(target)
  if ((canonicalRevisionState(queryClient).entityRevisions.get(canonicalEntityKey("notificationSettings", id)) ?? 0) > proof.token.canonicalRevision) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    if (level === null) deleteRows(registry, "notificationSettings", (row) => row.id === id, [id])
    else upsertRows(registry, "notificationSettings", [{ id, ...target, level }])
    return true
  })
}

export function publishCommunityFriendships(queryClient: QueryClient, rows: FriendshipRow[], proof: CommunityFreshQueryProof) {
  return withCommunityQueryProof(queryClient, proof, (registry) => notifyManager.batch(() => {
    const state = canonicalRevisionState(queryClient)
    const previous = collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" || row.kind === "outgoing")
    replaceRows(registry, "friendships", rows.filter((row) => (state.entityRevisions.get(canonicalEntityKey("friendships", `user:${row.userId}`)) ?? 0) <= proof.token.canonicalRevision), () => true)
    const pending = new Set(collectionRows(registry, "friendships").filter((row) => row.kind === "incoming" || row.kind === "outgoing").map((row) => row.id))
    retireCanonicalFriendRequests(registry, previous.filter((row) => !pending.has(row.id)).map((row) => row.id))
  }))
}

export function removeSettledCommunityFriendCommands(queryClient: QueryClient, ids: readonly string[]) {
  const cache = queryClient.getMutationCache()
  for (const mutation of cache.findAll({ mutationKey: ["community", "friend-request"], predicate: (entry) => entry.state.status !== "pending" && ids.includes((entry.state.variables as { friendshipId?: string } | undefined)?.friendshipId ?? "") })) cache.remove(mutation)
}

function retireCanonicalFriendRequests(registry: CommunityDbRegistry, ids: readonly string[]) {
  const eligible = new Set(ids.filter((id) => !isProtectedFromQueryWrite(registry, "friendships", id)))
  if (!eligible.size) return
  const items = collectionRows(registry, "attentionItems").filter((row) => row.kind === "friend_request" && eligible.has(row.sourceId) && !isProtectedFromQueryWrite(registry, "attentionItems", row.id))
  const present = new Set(collectionRows(registry, "friendships").filter((row) => eligible.has(row.id) && row.kind === "accepted").map((row) => row.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => {
    deleteRows(registry, "friendships", (row) => eligible.has(row.id) && (row.kind === "incoming" || row.kind === "outgoing"), [...eligible].filter((id) => !present.has(id)))
    recordEventPatches<FriendshipRow>(registry, "friendships", present, (row) => ({ ...row, kind: "accepted" }), present, ["kind"])
    const attentionIds = new Set([...items.map((row) => row.id), ...[...eligible].map((id) => `friend_request:${id}`)])
    deleteRows(registry, "attentionItems", (row) => attentionIds.has(row.id), attentionIds)
  })
  removeSettledCommunityFriendCommands(registry.queryClient, [...eligible])
}

export function publishCommunityFriendDecision(queryClient: QueryClient, friendshipId: string, action: "accept" | "reject" | "remove", proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  if (action === "accept") publishConfirmedFields(queryClient, "friendships", friendshipId, { kind: "accepted" as const, needsOwnerApproval: null }, proof)
  else if ((canonicalRevisionState(queryClient).entityRevisions.get(canonicalEntityKey("friendships", friendshipId)) ?? 0) <= proof.token.canonicalRevision) withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(registry, "friendships", (row) => row.id === friendshipId, [friendshipId]))
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === friendshipId))
  removeSettledCommunityFriendCommands(queryClient, [friendshipId])
}

export function applyCommunityDmBlockAccess(registry: CommunityDbRegistry, peerUserId: string, blocked: boolean) {
  if (peerUserId === registry.accountId) return
  const memberships = collectionRows(registry, "channelMemberships")
  const peerChannels = new Set(memberships.filter((row) => row.userId === peerUserId && row.relation === "access").map((row) => row.channelId))
  const viewerChannels = new Set(memberships.filter((row) => row.userId === registry.accountId && row.relation === "access").map((row) => row.channelId))
  const ids = new Set(collectionRows(registry, "channels")
    .filter((row) => row.type === "dm" && row.serverId === null && peerChannels.has(row.id) && viewerChannels.has(row.id))
    .map((row) => row.id))
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    for (const id of ids) {
      if (blocked) retireCommunityChannelReading(registry, id, { reason: "read-denied", serverId: null })
      else registry.runtime.ws.actions.beginChannelMembershipChange(null, id)
    }
  }))
}

export function publishCommunityFriendBlock(queryClient: QueryClient, userId: string, blocked: boolean, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!, state = canonicalRevisionState(queryClient)
  if ((state.entityRevisions.get(canonicalEntityKey("friendships", `user:${userId}`)) ?? 0) > proof.token.canonicalRevision) return
  const retired = blocked ? collectionRows(registry, "friendships").filter((row) => row.userId === userId).map((row) => row.id) : []
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    recordEventWrites(registry, "friendships", [`user:${userId}`])
    deleteRows(registry, "friendships", (row) => row.userId === userId && (blocked || row.kind === "blocked"))
    if (blocked) {
      upsertRows(registry, "friendships", [{ id: `blocked:${userId}`, userId, kind: "blocked" }])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.actorUserId === userId)
    }
  }))
  removeSettledCommunityFriendCommands(queryClient, retired)
}

function publishCreatedTreeRow<N extends "channels" | "categories">(
  queryClient: QueryClient,
  name: N,
  row: CommunityCollectionRows[N],
  proof: CommunityFreshQueryProof,
) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  const existing = collectionRows(registry, name).find((current) => current.id === row.id)
  if (!existing) withCommunityQueryProof(queryClient, proof, (owner) => upsertRows(owner, name, [row]))
  if (collectionRows(registry, name).some((current) => current.id === row.id)) {
    withCanonicalWriteContext(queryClient, { kind: "event" }, () => recordEventWrites(registry, name, [row.id]))
  }
}

export function publishCommunityCreatedChannel(queryClient: QueryClient, row: ChannelRow, proof: CommunityFreshQueryProof) {
  publishCreatedTreeRow(queryClient, "channels", row, proof)
  const registry = proof.token.registry!
  if (!registry.accountId || !collectionRows(registry, "channels").some((current) => current.id === row.id)) return
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => upsertRows(
    registry, "channelMemberships", [canonicalChannelMembershipRow(row.id, registry.accountId!, "access", { source: "inherited" })],
  ))
}

export function publishCommunityCreatedCategory(queryClient: QueryClient, row: CategoryRow, proof: CommunityFreshQueryProof) {
  publishCreatedTreeRow(queryClient, "categories", row, proof)
}

export function publishCommunityDeletedCategory(queryClient: QueryClient, categoryId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(proof.token.registry!, "categories", (row) => row.id === categoryId, [categoryId]))
}

export function publishCommunityServerMembershipRemoval(queryClient: QueryClient, serverId: string, proof: CommunityFreshQueryProof) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const registry = proof.token.registry!
  withCanonicalWriteContext(queryClient, { kind: "event" }, () => deleteRows(
    registry, "serverMemberships", (row) => row.serverId === serverId && row.viewer && row.userId === registry.accountId,
  ))
}

export function patchCanonicalCommunityMessage(
  queryClient: QueryClient,
  messageId: string,
  patch: (row: MessageRow) => MessageRow,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => (
    patchRows(
      registry,
      "messages",
      patch,
      (row) => row.id === messageId,
    )
  ))
}

export function removeCanonicalCommunityChannelMembership(
  queryClient: QueryClient,
  channelId: string,
  relation: "access" | "notify",
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId) return false
  deleteRows(
    registry,
    "channelMemberships",
    (row) => row.channelId === channelId
      && row.userId === registry.accountId
      && row.relation === relation,
  )
  return true
}

export function setCanonicalCommunityChannelMembership(
  queryClient: QueryClient,
  channelId: string,
  relation: "access" | "notify",
  present: boolean,
  options?: { event?: boolean },
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId) return false
  return setCanonicalCommunityChannelMember(queryClient, channelId, registry.accountId, relation, present, options)
}

export function setCanonicalCommunityChannelMember(queryClient: QueryClient, channelId: string, userId: string, relation: "access" | "notify", present: boolean, options?: { event?: boolean; proof?: CommunityFreshQueryProof }) {
  if (options?.proof) assertCommunityLiveSnapshotTokenCurrent(queryClient, options.proof.token, options.proof.signal)
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.runtime.lifecycle.get().active) return false
  const id = channelMembershipKey(channelId, userId, relation)
  const write = () => {
    if (!present) {
      deleteRows(registry, "channelMemberships", (row) => row.id === id, [id])
      return true
    }
    const previous = collectionRows(registry, "channelMemberships").find((row) => row.id === id)
    upsertRows(
      registry,
      "channelMemberships",
      [canonicalChannelMembershipRow(channelId, userId, relation, { ...previous, source: "explicit" })],
    )
    return true
  }
  if (options?.proof) return withCanonicalWriteContext(queryClient, { kind: "query", requestRevision: options.proof.token.canonicalRevision, profileSnapshot: options.proof.token.profileSnapshot }, () => isProtectedFromQueryWrite(registry, "channelMemberships", id) ? false : withCanonicalWriteContext(queryClient, { kind: "event" }, write))
  return options?.event
    ? withCanonicalWriteContext(queryClient, { kind: "event" }, write)
    : write()
}

export function getCanonicalCommunityChannels(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "channels") : []
}

export function getCanonicalCommunityAttentionScopes(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "attentionScopes") : []
}

export function getCanonicalCommunityAttentionItems(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "attentionItems") : []
}

export function getCanonicalCommunityChannelMemberships(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry
    ? collectionRows(registry, "channelMemberships")
    : []
}

export function getCanonicalCommunityMessages(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "messages") : []
}

export function purgeCommunityServer(registry: CommunityDbRegistry, serverId: string) {
  if (isProtectedFromQueryWrite(registry, "servers", serverId)) return
  const removedChannelIds = collectChannelScopeIds(registry.queryClient, serverId)
  for (const id of removedChannelIds) registry.runtime.ws.actions.revokeChannelAccess(serverId, id)
  clearChannelTransientState(registry, removedChannelIds, serverId)
  pruneInboxCaches(registry.queryClient, removedChannelIds, serverId)
  getAccountUnreadProjection(
    registry.queryClient,
    registry.accountId ?? "__anonymous__",
  ).retireAccessScope({
    kind: "server",
    serverId,
  })
  clearLastChannel(serverId)
  registry.runtime.ws.actions.revokeServerAccess(serverId)
  void registry.retireReadingDisk(removedChannelIds).catch((error: unknown) => console.error("Server cache retirement failed", error))
  registry.runtime.messageStream.actions.removeServer(serverId)
  registry.queryClient.setQueryData<string[]>(communityKeys.servers(), (current) => current?.filter((id) => id !== serverId))
  void registry.queryClient.cancelQueries({ queryKey: communityKeys.server(serverId) }, { revert: false })
  registry.queryClient.removeQueries({ queryKey: communityKeys.server(serverId) })
  const community = registry.runtime.ui.get()
  if (community.currentServerId === serverId) {
    registry.runtime.ui.actions.setCurrentChannelId(null)
    registry.runtime.ui.actions.setCurrentServerId(null)
  }
  notifyManager.batch(() => {
    deleteRows(registry, "servers", (row) => row.id === serverId, [serverId])
    deleteRows(registry, "categories", (row) => row.serverId === serverId)
    deleteRows(registry, "channels", (row) => removedChannelIds.has(row.id), removedChannelIds)
    deleteRows(registry, "serverMemberships", (row) => row.serverId === serverId)
    deleteRows(registry, "channelMemberships", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "messages", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "readStates", (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "attentionScopes", (row) => (
      row.serverId === serverId || removedChannelIds.has(row.channelId)
    ))
    deleteRows(registry, "attentionItems", (row) => (
      Boolean(row.scopeId && removedChannelIds.has(row.scopeId) || row.childChannelId && removedChannelIds.has(row.childChannelId) || row.readTarget && removedChannelIds.has(row.readTarget.channelId))
    ))
    deleteRows(registry, "folderItems", (row) => row.serverId === serverId)
    deleteRows(registry, "notificationSettings", (row) => (
      row.serverId === serverId || Boolean(row.channelId && removedChannelIds.has(row.channelId))
    ))
    garbageCollectCommunityProfiles(registry)
  })
}

type ThreadPageLike = {
  serverId?: string
  threads?: Array<{ id?: string }>
}

export function collectChannelScopeIds(
  queryClient: QueryClient,
  serverId: string | null,
  channelId?: string,
) {
  const ids = new Set<string>(channelId ? [channelId] : [])
  const store = getCommunityRuntime(queryClient).ui.get()
  const current = readCurrentCommunityChannelMeta(queryClient)
  if (store.currentServerId === serverId && store.currentChannelId
    && (!channelId || current?.parentChannelId === channelId)) ids.add(store.currentChannelId)
  for (const [id, scope] of getCommunityRuntime(queryClient).ws.get().channelAccessScopes) {
    if (scope.serverId === serverId && (!channelId || scope.parentChannelId === channelId)) ids.add(id)
  }
  for (const [, meta] of queryClient.getQueriesData<{ id: string; parentChannelId?: string }>(
    { queryKey: ["community", "channel"], predicate: (query) => query.queryKey[3] === "metadata" },
  )) {
    if (meta && ("serverId" in meta ? meta.serverId : getCommunityDbRegistry(queryClient)?.collections.channels.get(meta.id)?.serverId) === serverId
      && (!channelId || meta.parentChannelId === channelId)) ids.add(meta.id)
  }
  for (const { scope } of getCommunityRuntime(queryClient).messageStream.get().entries.values()) {
    if (!channelId && scope.kind === "channel" && scope.serverId === serverId) ids.add(scope.id)
  }
  const registry = getCommunityDbRegistry(queryClient)
  for (const row of registry?.collections.channels.values() ?? []) {
    if (row.serverId === serverId && (!channelId || row.id === channelId || row.parentChannelId === channelId)) ids.add(row.id)
  }
  for (const [key, data] of queryClient.getQueriesData<
    ThreadPageLike | { pages: ThreadPageLike[] }
  >({
    queryKey: ["community", "channel"],
    predicate: (query) => query.queryKey[3] === "threads" && (!channelId || query.queryKey[2] === channelId),
  })) {
    if (!data) continue
    const pages = "pages" in data ? data.pages : [data]
    for (const page of pages) {
      if (page.serverId !== serverId) continue
      ids.add(key[2] as string)
      for (const thread of page.threads ?? []) if (thread.id) ids.add(thread.id)
    }
  }
  return ids
}


export function retireCommunityChannelReading(
  registry: CommunityDbRegistry,
  channelId: string,
  options: { reason: "read-denied" | "resource-deleted"; serverId?: string | null; preserveQuery?: Query; queries?: ReadonlySet<Query>; assertView?: () => void; clearTransient?: boolean },
) {
  const root = registry.collections.channels.get(channelId)
  const serverId = options.serverId === undefined ? root?.serverId ?? null : options.serverId
  const removed = collectChannelScopeIds(registry.queryClient, serverId, channelId)
  for (const id of registry.runtime.ws.actions.revokeChannelAccess(serverId, channelId)) removed.add(id)
  for (const id of removed) if (!registry.runtime.ws.actions.isChannelAccessRevoked(id, serverId)) registry.runtime.ws.actions.revokeChannelAccess(serverId, id)
  void registry.retireReadingDisk(removed, options.reason === "resource-deleted")
    .catch((error: unknown) => console.error("Channel cache retirement failed", error))
  if (options.clearTransient !== false) clearChannelTransientState(registry, removed, serverId, options.preserveQuery, options)
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    patchRows(registry, "channels", (row) => ({ ...row, preview: "", unread: false, baseUnread: false, lastUnreadSeq: undefined }),
      (row) => removed.has(row.id), removed, ["preview", "unread", "baseUnread", "lastUnreadSeq"])
    deleteRows(registry, "messages", (row) => removed.has(row.channelId))
    deleteRows(registry, "readStates", (row) => removed.has(row.channelId))
    deleteRows(registry, "attentionScopes", (row) => removed.has(row.channelId))
    deleteRows(registry, "attentionItems", (row) => Boolean(row.scopeId && removed.has(row.scopeId) || row.childChannelId && removed.has(row.childChannelId) || row.readTarget && removed.has(row.readTarget.channelId)))
    if (options.reason === "resource-deleted" || root?.type !== "dm") {
      deleteRows(registry, "channels", (row) => removed.has(row.id), removed)
      deleteRows(registry, "channelMemberships", (row) => removed.has(row.channelId))
      deleteRows(registry, "notificationSettings", (row) => Boolean(row.channelId && removed.has(row.channelId)))
      garbageCollectCommunityProfiles(registry)
    }
  }))
  return removed
}

export function purgeCommunityChannel(registry: CommunityDbRegistry, channelId: string, clearTransient = true, preserveQuery?: Query) {
  if (isProtectedFromQueryWrite(registry, "channels", channelId) || !registry.collections.channels.has(channelId) && registry.runtime.ws.actions.isChannelAccessRevoked(channelId)) return
  retireCommunityChannelReading(registry, channelId, { reason: "resource-deleted", clearTransient, preserveQuery })
}

export function purgeCommunityForumPost(registry: CommunityDbRegistry, unit: { childChannelId: string; openerMessageId: string; serverId?: string }, options?: { queries?: ReadonlySet<Query>; assertView?: () => void }) {
  withCanonicalWriteContext(registry.queryClient, { kind: "event" }, () => notifyManager.batch(() => {
    if (registry.collections.channels.has(unit.childChannelId) || !registry.runtime.ws.actions.isChannelAccessRevoked(unit.childChannelId, unit.serverId)) retireCommunityChannelReading(registry, unit.childChannelId, { reason: "resource-deleted", serverId: unit.serverId, ...options })
    deleteRows(registry, "messages", (row) => row.id === unit.openerMessageId, [unit.openerMessageId])
    deleteRows(registry, "attentionItems", (row) => row.childChannelId === unit.childChannelId || row.messageId === unit.openerMessageId)
  }))
}

export function publishCommunityDeletedForumPost(queryClient: QueryClient, unit: { childChannelId: string; openerMessageId: string; serverId?: string }, proof: CommunityFreshQueryProof, options?: { queries?: ReadonlySet<Query>; assertView?: () => void }) {
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
  const state = canonicalRevisionState(queryClient)
  if ((state.entityRevisions.get(canonicalEntityKey("channels", unit.childChannelId)) ?? 0) > proof.token.canonicalRevision || (state.entityRevisions.get(canonicalEntityKey("messages", unit.openerMessageId)) ?? 0) > proof.token.canonicalRevision) return false
  purgeCommunityForumPost(proof.token.registry!, unit, options)
  return true
}

function projectProfilePatch(
  registry: CommunityDbRegistry,
  userId: string,
  patch: Omit<CommunityProfilePatch, "id">,
) {
  writeCommunityProfilePatches([{ id: userId, ...patch }], registry, { event: true })
}

/**
 * Applies low-latency WS facts directly to the canonical account-scoped
 * collections. Existing React Query handlers still own reconciliation and
 * fetch invalidation; a successful queryFn explicitly publishes its fresh
 * response into the same rows after its signal and account token are checked.
 */
export function projectCommunityWsEventToDb(
  queryClient: QueryClient,
  event: CommunityWsEvent,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return
  return withCanonicalWriteContext(queryClient, { kind: "event" }, () => {
    switch (event.type) {
    case "community:friend.request": {
      const row = event.friendship
      const otherId = row.requesterId === registry.accountId ? row.addresseeId : row.requesterId
      if (collectionRows(registry, "friendships").some((friendship) => friendship.kind === "blocked" && friendship.userId === otherId)) break
      const outgoing = row.requesterId === registry.accountId
      upsertRows(registry, "friendships", [{ id: row.id, userId: outgoing ? row.addresseeId : row.requesterId, kind: outgoing ? "outgoing" : "incoming" }])
      return
    }
    case "community:friend.accept":
      patchRows(registry, "friendships", (row) => ({ ...row, kind: "accepted" as const, needsOwnerApproval: null }), (row) => row.id === event.friendshipId, [event.friendshipId], ["kind", "needsOwnerApproval"])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === event.friendshipId)
      removeSettledCommunityFriendCommands(queryClient, [event.friendshipId])
      return
    case "community:friend.reject":
    case "community:friend.remove":
      deleteRows(registry, "friendships", (row) => row.id === event.friendshipId, [event.friendshipId])
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.sourceId === event.friendshipId)
      removeSettledCommunityFriendCommands(queryClient, [event.friendshipId])
      return
    case "community:friend.block": {
      const retired = collectionRows(registry, "friendships").filter((row) => row.userId === event.userId).map((row) => row.id)
      recordEventWrites(registry, "friendships", [`user:${event.userId}`])
      deleteRows(registry, "friendships", (row) => row.userId === event.userId)
      deleteRows(registry, "attentionItems", (row) => row.kind === "friend_request" && row.actorUserId === event.userId)
      removeSettledCommunityFriendCommands(queryClient, retired)
      return
    }
    case "community:message.create": {
      const projected = projectCommunityMessageCreate(event.message, event.channelId)
      ingestMessages(registry, event.channelId, [projected])
      if (event.message.createdAt) {
        patchRows(
          registry,
          "channels",
          (row) => ({ ...row, lastMessageAt: event.message.createdAt }),
          (row) => row.id === event.channelId,
          [event.channelId],
        )
      }
      return projected
    }
    case "community:message.edited":
      patchRows(
        registry,
        "messages",
        (row) => ({ ...row, content: event.content }),
        (row) => row.id === event.messageId,
        [event.messageId],
        ["content"],
      )
      return
    case "community:message.updated":
      patchRows(
        registry,
        "messages",
        (row) => ({ ...row, approval: event.approval }),
        (row) => row.id === event.messageId,
        [event.messageId],
        ["approval"],
      )
      return
    case "community:reaction.add":
    case "community:reaction.remove":
      patchRows(
        registry,
        "messages",
        (row) => ({ ...row, reactions: applyMessageReaction((row as MessageRow & Msg).reactions, event.emoji, event.userId, event.type === "community:reaction.add", registry.accountId || null) }),
        (row) => row.id === event.messageId,
        [event.messageId],
        ["reactions", `reaction:${event.emoji}:${event.userId}`],
      )
      return
    case "community:channel.child_create": {
      if (!event.parentMessageId) return
      const parent = collectionRows(registry, "channels")
        .find((row) => row.id === event.parentChannelId)
      if (!parent?.serverId) return
      upsertRows(registry, "channels", [canonicalChannelRow({
        id: event.channel.id,
        serverId: parent.serverId,
        name: event.channel.name,
        type: "thread",
        parentChannelId: event.parentChannelId,
        parentMessageId: event.parentMessageId,
        creatorId: event.channel.creatorId ?? null,
        lastMessageAt: event.channel.createdAt,
      })])
      if (registry.accountId) {
        upsertRows(
          registry,
          "channelMemberships",
          [canonicalChannelMembershipRow(event.channel.id, registry.accountId, "access", { source: "explicit" })],
        )
      }
      return
    }
    case "community:channel.child_update":
      patchRows(
        registry,
        "channels",
        (row) => ({
          ...row,
          ...(event.changes.name === undefined ? {} : { name: event.changes.name }),
          ...(event.changes.archived === undefined ? {} : { archived: event.changes.archived }),
          ...(event.changes.tags === undefined ? {} : { tags: event.changes.tags ?? [] }),
          ...(event.changes.lastMessageAt === undefined ? {} : { lastMessageAt: event.changes.lastMessageAt }),
          ...(event.changes.messageCount === undefined ? {} : { messageCount: event.changes.messageCount }),
        }),
        (row) => row.id === event.channelId,
        [event.channelId],
        Object.keys(event.changes),
      )
      return
    case "community:server.update":
      patchRows(
        registry,
        "servers",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.serverId,
        [event.serverId],
        Object.keys(event.changes),
      )
      return
    case "community:channel.create":
      upsertRows(registry, "channels", [canonicalChannelRow({
        id: event.channel.id,
        serverId: event.serverId,
        categoryId: event.channel.categoryId ?? null,
        name: event.channel.name,
        type: event.channel.type,
        position: event.channel.position,
        lastMessageAt: event.channel.createdAt,
      })])
      return
    case "community:channel.update":
      patchRows(
        registry,
        "channels",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.channelId,
        [event.channelId],
        Object.keys(event.changes),
      )
      return
    case "community:channel.delete":
      if (event.parentChannelId && event.parentMessageId) {
        purgeCommunityForumPost(registry, { childChannelId: event.channelId, openerMessageId: event.parentMessageId })
      } else purgeCommunityChannel(registry, event.channelId)
      return
    case "community:channel.reorder": {
      const positionById = new Map(event.channels.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "channels",
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
        ["position"],
      )
      return
    }
    case "community:channel.membership.change":
    case "community:channel.member_add":
    case "community:channel.member_remove":
      // Relation ownership depends on resolved channel type. The membership
      // handler publishes this only after canonical metadata proves whether
      // the event changes thread notify or top-level access.
      return
    case "community:category.create":
      upsertRows(registry, "categories", [{
        id: event.category.id,
        serverId: event.serverId,
        name: event.category.name,
        position: event.category.position,
        private: event.category.private,
        pending: false,
      }])
      return
    case "community:category.update":
      patchRows(
        registry,
        "categories",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.categoryId,
        [event.categoryId],
        Object.keys(event.changes),
      )
      return
    case "community:category.delete":
      deleteRows(
        registry,
        "categories",
        (row) => row.id === event.categoryId,
        [event.categoryId],
      )
      return
    case "community:category.reorder": {
      const positionById = new Map(event.categories.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "categories",
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
        ["position"],
      )
      return
    }
    case "community:member.join":
      upsertRows(registry, "serverMemberships", [{
        id: serverMembershipKey(event.serverId, event.member.userId),
        serverId: event.serverId,
        userId: event.member.userId,
        memberId: event.member.id,
        role: event.member.role,
        joinedAt: event.member.joinedAt,
        viewer: event.member.userId === registry.accountId,
      }])
      writeCommunityProfilePatches([communityUserProfilePatch(event.member.userId, {
        name: event.member.name,
        discriminator: event.member.discriminator,
        avatar: event.member.avatar ?? "",
        avatarVersion: event.member.avatarVersion,
      })], registry, { event: true })
      return
    case "community:member.leave":
      if (event.userId !== registry.accountId) {
        deleteRows(
          registry,
          "serverMemberships",
          (row) => row.serverId === event.serverId && row.userId === event.userId,
          [serverMembershipKey(event.serverId, event.userId)],
        )
      }
      return
    case "community:member.update":
      patchRows(
        registry,
        "serverMemberships",
        (row) => ({ ...row, ...event.changes }),
        (row) => row.serverId === event.serverId
          && (row.memberId === event.memberId || Boolean(event.userId && row.userId === event.userId)),
        event.userId ? [serverMembershipKey(event.serverId, event.userId)] : undefined,
        Object.keys(event.changes),
      )
      return
    case "community:unread.bump":
      if (event.userId !== registry.accountId) return
      patchRows(
        registry,
        "channels",
        (row) => ({ ...row, unread: true }),
        (row) => row.id === event.channelId || row.id === event.railChannelId,
        [event.channelId, event.railChannelId]
          .filter((channelId): channelId is string => Boolean(channelId)),
      )
      if (event.serverId) {
        patchRows(
          registry,
          "servers",
          (row) => ({
            ...row,
            unread: true,
            mentions: row.mentions + (event.isMention ? 1 : 0),
          }),
          (row) => row.id === event.serverId,
          [event.serverId],
        )
      }
      return
    case "community:status.update":
      projectProfilePatch(registry, event.userId, {
        status: {
          statusEmoji: event.statusEmoji,
          statusText: event.statusText,
        },
      })
      return
    case "community:identity.update":
      projectProfilePatch(registry, event.userId, {
        avatar: {
          avatar: event.avatar,
          avatarVersion: event.avatarVersion,
        },
      })
      return
    case "community:profile.update": {
      projectProfilePatch(registry, event.userId, {
        identityAbout: {
          name: event.name,
          discriminator: event.discriminator,
          aboutMe: event.aboutMe,
          bannerColor: event.bannerColor,
          kind: event.kind,
          ownerUserId: event.ownerUserId,
        },
      })
      return
    }
      default:
        return
    }
  })
}

export function installCommunityDbSync(
  queryClient: QueryClient,
  registry: CommunityDbRegistry,
) {
  // Canonical collections hydrate themselves. Raw Query payloads are never
  // replayed into DB: a cache notification does not prove request freshness.
  void queryClient
  void registry.preload().catch((error: unknown) => {
    if (isAbortError(error)) return
    console.error("Community collection preload failed", error)
  })
  return () => {}
}

export function communityRequestOptions(queryClient: QueryClient, signal?: AbortSignal) {
  const token = captureCommunityLiveSnapshotToken(queryClient)
  return qualifiedCommunityRequestOptions(queryClient, token, signal)
}
