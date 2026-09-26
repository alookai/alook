import { notifyManager, type QueryClient } from "@tanstack/react-query"
import type { Query } from "@tanstack/react-query"
import { UNCATEGORIZED_CATEGORY_ID, type CommunityWsEvent } from "@alook/shared"
import type { DmsResponse } from "@/hooks/community/use-dms"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type {
  AccountReadStateSnapshot,
} from "@/hooks/community/community-ws/read-state-reconciliation"
import type { ServerDetail, ServersResponse } from "@/hooks/community/use-servers"
import type { Msg } from "@/lib/community/models/message"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import {
  communityUserProfilePatch,
  messageProfilePatches,
  writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import type { CommunityProfilePatch } from "@/lib/community/models/people"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { projectCommunityMessageCreate } from "@/lib/community/message-wire"
import { clearTypingIndicator } from "@/hooks/community/community-ws/typing"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
import { takeMessageIdsForAccessScope } from "./message-access-scope"
import { clearLastChannel, getLastChannel } from "@/lib/community/last-channel"
import { clearLastMeLocation, getLastMeLeaf } from "@/lib/community/last-me-location"
import {
  getCommunityDbRegistry,
  type CommunityDbRegistry,
} from "./collections"
import {
  categorySchema,
  channelMembershipKey,
  channelMembershipSchema,
  channelSchema,
  folderItemKey,
  folderItemSchema,
  folderSchema,
  messageSchema,
  notificationSettingKey,
  notificationSettingSchema,
  profileSchema,
  readStateClockSchema,
  readStateSchema,
  serverMembershipKey,
  serverMembershipSchema,
  serverSchema,
  type CategoryRow,
  type ChannelMembershipRow,
  type ChannelRow,
  type FolderItemRow,
  type FolderRow,
  type MessageRow,
  type NotificationSettingRow,
  type ReadStateClockRow,
  type ReadStateRow,
  type ServerMembershipRow,
  type ServerRow,
} from "./schema"
import type { z } from "zod"

type CollectionName = keyof CommunityDbRegistry["collections"]
type SnapshotIngestMode = "authoritative" | "merge"

type CanonicalRevisionState = {
  revision: number
  entityRevisions: Map<string, number>
  pendingOperations: Map<string, CanonicalPendingOperation[]>
}

type CanonicalPendingOperation =
  | { revision: number; kind: "patch"; apply: (row: object) => object }
  | { revision: number; kind: "delete" }

type CanonicalWriteContext =
  | { kind: "event" }
  | { kind: "query"; requestRevision: number }

const canonicalRevisionStates = new WeakMap<QueryClient, CanonicalRevisionState>()
const canonicalWriteContexts = new WeakMap<QueryClient, CanonicalWriteContext>()

function canonicalRevisionState(queryClient: QueryClient) {
  let state = canonicalRevisionStates.get(queryClient)
  if (!state) {
    state = { revision: 0, entityRevisions: new Map(), pendingOperations: new Map() }
    canonicalRevisionStates.set(queryClient, state)
  }
  return state
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
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  const state = canonicalRevisionState(registry.queryClient)
  for (const key of new Set(keys)) {
    state.revision += 1
    state.entityRevisions.set(canonicalEntityKey(name, key), state.revision)
  }
}

function recordEventPatches<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
  patch: (row: T) => T,
  presentKeys: ReadonlySet<string>,
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  const state = canonicalRevisionState(registry.queryClient)
  for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    if (presentKeys.has(key)) {
      state.pendingOperations.delete(entityKey)
      continue
    }
    const pending = state.pendingOperations.get(entityKey) ?? []
    pending.push({
      revision: state.revision,
      kind: "patch",
      apply: patch as unknown as (row: object) => object,
    })
    state.pendingOperations.set(entityKey, pending)
  }
}

function recordEventDeletes(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  if (canonicalWriteContexts.get(registry.queryClient)?.kind !== "event") return
  const state = canonicalRevisionState(registry.queryClient)
  for (const key of new Set(keys)) {
    state.revision += 1
    const entityKey = canonicalEntityKey(name, key)
    state.entityRevisions.set(entityKey, state.revision)
    state.pendingOperations.set(entityKey, [{
      revision: state.revision,
      kind: "delete",
    }])
  }
}

function clearPendingOperations(
  registry: CommunityDbRegistry,
  name: CollectionName,
  keys: Iterable<string>,
) {
  const pending = canonicalRevisionState(registry.queryClient).pendingOperations
  for (const key of keys) pending.delete(canonicalEntityKey(name, key))
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
    return publish()
  } finally {
    if (previous) canonicalWriteContexts.set(queryClient, previous)
    else canonicalWriteContexts.delete(queryClient)
  }
}

function collectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
) {
  const cached = registry.queryClient.getQueryData<T[]>(
    communityKeys.communityDbCollection(registry.scopeId, name),
  )
  if (cached) return cached.flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
  const collection = registry.collections[name] as unknown as {
    values: () => IterableIterator<unknown>
  }
  return Array.from(collection.values()).flatMap((row) => {
    const parsed = schema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

function publishRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  rows: T[],
) {
  registry.queryClient.setQueryData(
    communityKeys.communityDbCollection(registry.scopeId, name),
    rows,
  )
}

function writeCollectionRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  rows: T[],
  getKey: (row: T) => string,
) {
  const collection = registry.collections[name] as unknown as {
    status: string
    keys: () => IterableIterator<string>
    utils: {
      writeBatch: (callback: () => void) => void
      writeDelete: (keys: string | string[]) => void
      writeUpsert: (rows: T | T[]) => void
    }
  }
  if (collection.status !== "ready") return
  const nextKeys = new Set(rows.map(getKey))
  const removed = Array.from(collection.keys()).filter((key) => !nextKeys.has(key))
  collection.utils.writeBatch(() => {
    if (removed.length > 0) collection.utils.writeDelete(removed)
    if (rows.length > 0) collection.utils.writeUpsert(rows)
  })
}

function replaceRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  getKey: (row: T) => string,
  incoming: T[],
  owns: (row: T) => boolean,
) {
  const parsedIncoming = incoming.map((row) => schema.parse(row))
  const current = collectionRows(registry, name, schema)
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
  writeCollectionRows(registry, name, next, getKey)
  publishRows(registry, name, next)
  recordEventWrites(registry, name, [
    ...current.filter(owns).map(getKey),
    ...parsedIncoming.map(getKey),
  ])
}

function upsertRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  getKey: (row: T) => string,
  incoming: T[],
) {
  const parsedIncoming = incoming.map((row) => schema.parse(row))
  const nextByKey = new Map(
    collectionRows(registry, name, schema).map((row) => [getKey(row), row]),
  )
  const acceptedKeys: string[] = []
  for (const row of parsedIncoming) {
    const key = getKey(row)
    if (!isProtectedFromQueryWrite(registry, name, key)) {
      nextByKey.set(key, row)
      acceptedKeys.push(key)
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
  writeCollectionRows(registry, name, next, getKey)
  publishRows(registry, name, next)
  recordEventWrites(registry, name, acceptedKeys)
}

function patchRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  getKey: (row: T) => string,
  patch: (row: T) => T,
  matches: (row: T) => boolean,
  eventKeys?: Iterable<string>,
) {
  const current = collectionRows(registry, name, schema)
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
    writeCollectionRows(registry, name, next, getKey)
    publishRows(registry, name, next)
  }
  if (eventKeys) {
    recordEventPatches(registry, name, eventKeys, patch, new Set(changedKeys))
  }
  else recordEventWrites(registry, name, changedKeys)
  return changed
}

function deleteRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  remove: (row: T) => boolean,
  eventKeys?: Iterable<string>,
) {
  const current = collectionRows(registry, name, schema)
  const removedKeys: string[] = []
  const next = current.filter((row) => {
    if (!remove(row)) return true
    const key = (registry.collections[name] as unknown as {
      getKeyFromItem: (value: T) => string
    }).getKeyFromItem(row)
    if (isProtectedFromQueryWrite(registry, name, key)) return true
    removedKeys.push(key)
    return false
  })
  const keyByValue = new Map(current.map((row) => [row, (
    registry.collections[name] as unknown as { getKeyFromItem: (value: T) => string }
  ).getKeyFromItem(row)]))
  writeCollectionRows(registry, name, next, (row) => keyByValue.get(row)!)
  publishRows(registry, name, next)
  if (eventKeys) recordEventDeletes(registry, name, eventKeys)
  else recordEventWrites(registry, name, removedKeys)
}

function referencedProfileIds(registry: CommunityDbRegistry) {
  const ids = new Set<string>(registry.accountId ? [registry.accountId] : [])
  for (const row of collectionRows(registry, "servers", serverSchema)) {
    if (row.ownerId) ids.add(row.ownerId)
  }
  for (const row of collectionRows(registry, "serverMemberships", serverMembershipSchema)) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "channelMemberships", channelMembershipSchema)) {
    ids.add(row.userId)
  }
  for (const row of collectionRows(registry, "messages", messageSchema)) {
    const message = row as MessageRow & Msg
    if (message.authorId) ids.add(message.authorId)
    if (message.replyTo?.authorId) ids.add(message.replyTo.authorId)
    for (const participant of message.thread?.participants ?? []) ids.add(participant.id)
    for (const profile of [
      message.approval?.otherProfile,
      message.approval?.botProfile,
      message.approval?.waitingOnProfile,
    ]) {
      if (profile?.id) ids.add(profile.id)
    }
  }
  return ids
}

function garbageCollectCommunityProfiles(registry: CommunityDbRegistry) {
  const referenced = referencedProfileIds(registry)
  deleteRows(
    registry,
    "profiles",
    profileSchema,
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
) {
  const messageIds = new Set([
    ...takeMessageIdsForAccessScope(registry.queryClient, channelIds, serverId),
    ...collectionRows(registry, "messages", messageSchema)
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
  for (const entry of useMessageStreamStore.getState().entries.values()) {
    if (channelIds.has(entry.scope.id)) useMessageStreamStore.getState().removeScope(entry.scope)
  }
  const community = useCommunityStore.getState()
  const unreadProjection = getAccountUnreadProjection(
    registry.queryClient,
    registry.accountId ?? "__anonymous__",
  )
  for (const channelId of channelIds) {
    unreadProjection.retireAccessScope({ kind: "channel", channelId })
    for (const scope of [`ch:${channelId}`, `dm:${channelId}`]) {
      for (const userId of community.typingByScope.get(scope)?.keys() ?? []) {
        clearTypingIndicator(scope, userId)
      }
    }
    if (serverId) useCommunityWsStore.getState().revokeChannelAccess(serverId, channelId)
  }
  pruneInboxCaches(registry.queryClient, channelIds, null)
  if (serverId) {
    const remembered = getLastChannel(serverId)
    if (remembered && channelIds.has(remembered)) clearLastChannel(serverId)
  } else {
    const remembered = getLastMeLeaf()
    if (remembered && channelIds.has(remembered)) clearLastMeLocation()
  }
  if (community.currentChannelId && channelIds.has(community.currentChannelId)) {
    community.setCurrentChannelMeta(null)
    community.setCurrentChannelId(null)
  }
  const subscription = { ...community.subscription }
  if (subscription.channelId && channelIds.has(subscription.channelId)) delete subscription.channelId
  if (subscription.secondaryChannelId && channelIds.has(subscription.secondaryChannelId)) {
    delete subscription.secondaryChannelId
    useCommunityStore.setState({ secondaryChannelOwner: null })
  }
  if (subscription.dmConversationId && channelIds.has(subscription.dmConversationId)) {
    delete subscription.dmConversationId
  }
  useCommunityStore.setState({ subscription })
  if (community.pendingReply && channelIds.has(community.pendingReply.channelId)) {
    community.setPendingReply(null)
  }
  const predicate = (query: Query) => {
    const key = query.queryKey
    if (key[0] !== "community" || key[1] === "db") return false
    if ((key[1] === "channel" || key[1] === "dm") && channelIds.has(String(key[2]))) return true
    if (key[1] === "message-context" && channelIds.has(String(key[3]))) return true
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
  mode: SnapshotIngestMode = "authoritative",
) {
  const currentServers = collectionRows(registry, "servers", serverSchema)
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
        role: server.isOwner ? "owner" : "member",
        viewer: true,
      }))
    : []
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      for (const serverId of removedServerIds) purgeCommunityServer(registry, serverId)
      replaceRows(registry, "servers", serverSchema, (row) => row.id, servers, () => true)
    } else {
      upsertRows(registry, "servers", serverSchema, (row) => row.id, servers)
    }
    if (viewerId) {
      if (mode === "authoritative") {
        replaceRows(
          registry,
          "serverMemberships",
          serverMembershipSchema,
          (row) => row.id,
          memberships,
          (row) => row.viewer,
        )
      } else {
        upsertRows(
          registry,
          "serverMemberships",
          serverMembershipSchema,
          (row) => row.id,
          memberships,
        )
      }
    }
  })
}

export function ingestServerDetail(
  registry: CommunityDbRegistry,
  detail: ServerDetail,
  mode: SnapshotIngestMode = "authoritative",
) {
  const existing = collectionRows(registry, "servers", serverSchema)
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
      channels.push({
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
      })
    })
  })
  const currentTopLevelIds = new Set(
    collectionRows(registry, "channels", channelSchema)
      .filter((row) => row.serverId === detail.id && row.type !== "thread")
      .map((row) => row.id),
  )
  const incomingTopLevelIds = new Set(channels.map((row) => row.id))
  const removedTopLevelIds = [...currentTopLevelIds]
    .filter((channelId) => !incomingTopLevelIds.has(channelId))
  const viewerId = registry.accountId
  const accessMemberships: ChannelMembershipRow[] = viewerId
    ? channels.map((channel) => ({
        id: channelMembershipKey(channel.id, viewerId, "access"),
        channelId: channel.id,
        userId: viewerId,
        relation: "access",
        source: "inherited",
      }))
    : []
  const existingChannels = new Map(
    collectionRows(registry, "channels", channelSchema).map((row) => [row.id, row]),
  )
  const unreadChildOwnership = Object.entries(detail.forumUnreadState ?? {})
    .flatMap(([parentChannelId, state]) => state.childIds.map((childId) => ({
      childId,
      parentChannelId,
    })))
  const unreadChildStubs: ChannelRow[] = unreadChildOwnership.flatMap((ownership) => {
    if (existingChannels.has(ownership.childId)) return []
    return [{
      id: ownership.childId,
      serverId: detail.id,
      categoryId: null,
      name: "",
      type: "thread" as const,
      parentChannelId: ownership.parentChannelId,
      parentMessageId: null,
      creatorId: null,
      position: 0,
      archived: false,
      muted: false,
      unread: true,
      tags: [],
      pending: false,
      lastMessageAt: null,
    }]
  })
  const unreadChildMemberships: ChannelMembershipRow[] = viewerId
    ? unreadChildOwnership.flatMap(({ childId }) => ([
        {
          id: channelMembershipKey(childId, viewerId, "access"),
          channelId: childId,
          userId: viewerId,
          relation: "access" as const,
          source: "explicit" as const,
        },
        {
          id: channelMembershipKey(childId, viewerId, "notify"),
          channelId: childId,
          userId: viewerId,
          relation: "notify" as const,
          source: "explicit" as const,
        },
      ]))
    : []
  const authoritativeTopLevelIds = new Set([...currentTopLevelIds, ...incomingTopLevelIds])
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      for (const channelId of removedTopLevelIds) purgeCommunityChannel(registry, channelId)
    }
    upsertRows(registry, "servers", serverSchema, (row) => row.id, [server])
    if (mode === "authoritative") {
      replaceRows(
        registry,
        "categories",
        categorySchema,
        (row) => row.id,
        categories,
        (row) => row.serverId === detail.id,
      )
      replaceRows(
        registry,
        "channels",
        channelSchema,
        (row) => row.id,
        channels,
        (row) => row.serverId === detail.id && row.type !== "thread",
      )
    } else {
      upsertRows(registry, "categories", categorySchema, (row) => row.id, categories)
      upsertRows(registry, "channels", channelSchema, (row) => row.id, channels)
    }
    if (viewerId) {
      if (mode === "authoritative") {
        replaceRows(
          registry,
          "channelMemberships",
          channelMembershipSchema,
          (row) => row.id,
          accessMemberships,
          (row) => row.userId === viewerId
            && row.relation === "access"
            && authoritativeTopLevelIds.has(row.channelId),
        )
      } else {
        upsertRows(
          registry,
          "channelMemberships",
          channelMembershipSchema,
          (row) => row.id,
          accessMemberships,
        )
      }
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        unreadChildMemberships,
      )
    }
    upsertRows(registry, "channels", channelSchema, (row) => row.id, unreadChildStubs)
    const unreadChildren = new Set(
      Object.values(detail.forumUnreadState ?? {}).flatMap((state) => state.childIds),
    )
    patchRows(
      registry,
      "channels",
      channelSchema,
      (row) => row.id,
      (row) => ({ ...row, unread: unreadChildren.has(row.id) }),
      (row) => row.serverId === detail.id && row.type === "thread",
    )
  })
}

function ingestChannelMetadata(
  registry: CommunityDbRegistry,
  metadata: {
    id: string
    serverId: string
    name: string
    type: string
    parentChannelId: string | null
    parentMessageId: string | null
    creatorId: string | null
    archived: boolean | number
    lastMessageAt: string | null
  },
) {
  if (!(["text", "forum", "thread"] as const).includes(metadata.type as "text")) return
  const existing = collectionRows(registry, "channels", channelSchema)
    .find((row) => row.id === metadata.id)
  upsertRows(registry, "channels", channelSchema, (row) => row.id, [{
    id: metadata.id,
    serverId: metadata.serverId,
    categoryId: existing?.categoryId ?? null,
    name: metadata.name,
    type: metadata.type as ChannelRow["type"],
    parentChannelId: metadata.parentChannelId,
    parentMessageId: metadata.parentMessageId,
    creatorId: metadata.creatorId,
    position: existing?.position ?? 0,
    archived: metadata.archived === true || metadata.archived === 1,
    muted: existing?.muted ?? false,
    unread: existing?.unread ?? false,
    ...(existing?.baseUnread === undefined ? {} : { baseUnread: existing.baseUnread }),
    tags: existing?.tags ?? [],
    pending: false,
    lastMessageAt: metadata.lastMessageAt,
  }])
}

export function ingestDms(
  registry: CommunityDbRegistry,
  response: DmsResponse,
  mode: SnapshotIngestMode = "authoritative",
) {
  const viewerId = registry.accountId
  if (!viewerId) return
  const currentDmIds = new Set(
    collectionRows(registry, "channels", channelSchema)
      .filter((row) => row.type === "dm")
      .map((row) => row.id),
  )
  const channels: ChannelRow[] = []
  const memberships: ChannelMembershipRow[] = []
  const profilePatches: CommunityProfilePatch[] = []
  for (const dm of response.conversations) {
    channels.push({
      id: dm.id,
      serverId: null,
      categoryId: null,
      name: "",
      type: "dm",
      parentChannelId: null,
      parentMessageId: null,
      creatorId: null,
      position: 0,
      archived: false,
      muted: false,
      unread: dm.unread === true,
      tags: [],
      pending: false,
      lastMessageAt: null,
      preview: dm.preview,
      ...(dm.lastUnreadSeq === undefined ? {} : { lastUnreadSeq: dm.lastUnreadSeq }),
    })
    memberships.push(
      {
        id: channelMembershipKey(dm.id, viewerId, "access"),
        channelId: dm.id,
        userId: viewerId,
        relation: "access",
      },
      {
        id: channelMembershipKey(dm.id, dm.userId, "access"),
        channelId: dm.id,
        userId: dm.userId,
        relation: "access",
      },
    )
    profilePatches.push(communityUserProfilePatch(dm.userId, dm))
  }
  const dmIds = new Set(channels.map((row) => row.id))
  const authoritativeDmIds = new Set([...currentDmIds, ...dmIds])
  const removedDmIds = [...currentDmIds].filter((channelId) => !dmIds.has(channelId))
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      for (const channelId of removedDmIds) purgeCommunityChannel(registry, channelId)
      replaceRows(registry, "channels", channelSchema, (row) => row.id, channels, (row) => row.type === "dm")
      replaceRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        memberships,
        (row) => row.relation === "access" && authoritativeDmIds.has(row.channelId),
      )
    } else {
      upsertRows(registry, "channels", channelSchema, (row) => row.id, channels)
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        memberships,
      )
    }
    writeCommunityProfilePatches(profilePatches, registry)
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
  mode: SnapshotIngestMode = "authoritative",
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
    if (mode === "authoritative") {
      replaceRows(registry, "folders", folderSchema, (row) => row.id, folders, () => true)
      replaceRows(registry, "folderItems", folderItemSchema, (row) => row.id, items, () => true)
    } else {
      upsertRows(registry, "folders", folderSchema, (row) => row.id, folders)
      upsertRows(registry, "folderItems", folderItemSchema, (row) => row.id, items)
    }
  })
}

export function ingestMessages(
  registry: CommunityDbRegistry,
  channelId: string,
  messages: Msg[],
) {
  const rows: MessageRow[] = messages
    .filter((message) => !message.id.startsWith("temp_") && message.failed !== true)
    .map((message) => ({
      ...message,
      channelId,
      replyToId: message.replyTo?.id,
    }))
  upsertRows(registry, "messages", messageSchema, (row) => row.id, rows)
  writeCommunityProfilePatches(messageProfilePatches(messages), registry)
}

export function ingestReadStateSnapshot(
  registry: CommunityDbRegistry,
  snapshot: AccountReadStateSnapshot,
  mode: SnapshotIngestMode = "authoritative",
) {
  const currentRevision = collectionRows(registry, "readStateClock", readStateClockSchema)
    .find((row) => row.id === "account")?.revision ?? -1
  if (snapshot.revision <= currentRevision) return
  const readStates: ReadStateRow[] = snapshot.readStates.map((row) => ({ ...row }))
  const clock: ReadStateClockRow = { id: "account", revision: snapshot.revision }
  notifyManager.batch(() => {
    if (mode === "authoritative") {
      replaceRows(registry, "readStates", readStateSchema, (row) => row.channelId, readStates, () => true)
      replaceRows(registry, "readStateClock", readStateClockSchema, (row) => row.id, [clock], () => true)
    } else {
      upsertRows(registry, "readStates", readStateSchema, (row) => row.channelId, readStates)
      upsertRows(registry, "readStateClock", readStateClockSchema, (row) => row.id, [clock])
    }
  })
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
      notificationSettingSchema,
      (row) => row.id,
      rows,
      () => true,
    )
  } else {
    upsertRows(
      registry,
      "notificationSettings",
      notificationSettingSchema,
      (row) => row.id,
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
  readonly canonicalRevision: number
  readonly queryClient: QueryClient
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
  signal: AbortSignal | undefined
}

export function captureCommunityLiveSnapshotToken(
  queryClient: QueryClient,
): CommunityLiveSnapshotToken {
  const state = useCommunityWsStore.getState()
  return {
    viewerId: state.profileViewerId,
    accountEpoch: state.profileAccountEpoch,
    accessEpoch: state.accessEpoch,
    canonicalRevision: canonicalRevisionState(queryClient).revision,
    queryClient,
  } as CommunityLiveSnapshotToken
}

export function assertCommunityLiveSnapshotTokenCurrent(
  queryClient: QueryClient,
  token: CommunityLiveSnapshotToken,
  signal: AbortSignal | undefined,
) {
  const state = useCommunityWsStore.getState()
  if (
    signal?.aborted
    || state.profileViewerId !== token.viewerId
    || state.profileAccountEpoch !== token.accountEpoch
    || state.accessEpoch !== token.accessEpoch
    || queryClient !== token.queryClient
  ) throw new DOMException("Stale community live snapshot", "AbortError")
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
  assertCommunityLiveSnapshotTokenCurrent(queryClient, proof.token, proof.signal)
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
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: proof.token.canonicalRevision,
  }, () => {
    switch (snapshot.kind) {
      case "servers":
        ingestServers(registry, snapshot.data)
        break
      case "server-detail":
        ingestServerDetail(registry, snapshot.data)
        break
      case "folders":
        ingestFolders(registry, snapshot.data)
        break
      case "dms":
        ingestDms(registry, snapshot.data)
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

/** Merge confirmed rows from one fresh transport response into canonical DB. */
export function publishCommunityMessages(
  queryClient: QueryClient,
  publication: {
    channelId: string
    messages: Msg[]
    proof: CommunityFreshQueryProof
  },
) {
  assertCommunityLiveSnapshotTokenCurrent(
    queryClient,
    publication.proof.token,
    publication.proof.signal,
  )
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: publication.proof.token.canonicalRevision,
  }, () => {
    ingestMessages(registry, publication.channelId, publication.messages)
    return "published" as const
  })
}

/** Publish message entities embedded in a cross-scope transport response. */
export function publishCommunityEmbeddedMessages(
  queryClient: QueryClient,
  publication: {
    entries: Array<{ channelId: string; message: Msg }>
    proof: CommunityFreshQueryProof
  },
) {
  assertCommunityLiveSnapshotTokenCurrent(
    queryClient,
    publication.proof.token,
    publication.proof.signal,
  )
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: publication.proof.token.canonicalRevision,
  }, () => {
    const byChannel = new Map<string, Msg[]>()
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

export type CommunityChannelMetadata = {
  id: string
  serverId: string
  name: string
  type: string
  parentChannelId: string | null
  parentMessageId: string | null
  creatorId: string | null
  archived: boolean | number
  lastMessageAt: string | null
}

/** Publish one verified channel metadata response and its viewer access fact. */
export function publishCommunityChannelMetadata(
  queryClient: QueryClient,
  publication: {
    metadata: CommunityChannelMetadata
    proof: CommunityFreshQueryProof
  },
) {
  assertCommunityLiveSnapshotTokenCurrent(
    queryClient,
    publication.proof.token,
    publication.proof.signal,
  )
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: publication.proof.token.canonicalRevision,
  }, () => {
    ingestChannelMetadata(registry, publication.metadata)
    const viewerId = registry.accountId
    if (viewerId) {
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        [{
          id: channelMembershipKey(publication.metadata.id, viewerId, "access"),
          channelId: publication.metadata.id,
          userId: viewerId,
          relation: "access",
          source: "explicit",
        }],
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
  assertCommunityLiveSnapshotTokenCurrent(
    queryClient,
    publication.proof.token,
    publication.proof.signal,
  )
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: publication.proof.token.canonicalRevision,
  }, () => {
    const existingServers = new Map(
    collectionRows(registry, "servers", serverSchema).map((row) => [row.id, row]),
  )
  const existingChannels = new Map(
    collectionRows(registry, "channels", channelSchema).map((row) => [row.id, row]),
  )
  const viewerId = registry.accountId
  const servers: ServerRow[] = publication.directory.map((server, position) => ({
    id: server.id,
    position: existingServers.get(server.id)?.position ?? position,
    name: server.name,
    discriminator: server.discriminator,
    description: existingServers.get(server.id)?.description ?? "",
    ownerId: existingServers.get(server.id)?.ownerId ?? "",
    icon: existingServers.get(server.id)?.icon ?? null,
    official: existingServers.get(server.id)?.official ?? false,
    isOwner: existingServers.get(server.id)?.isOwner ?? false,
    unread: existingServers.get(server.id)?.unread ?? false,
    mentions: existingServers.get(server.id)?.mentions ?? 0,
    detailComplete: existingServers.get(server.id)?.detailComplete ?? false,
  }))
  const channels: ChannelRow[] = publication.directory.flatMap((server) => (
    server.channels.flatMap((channel, position) => {
      const existing = existingChannels.get(channel.id)
      const type = channel.type ?? existing?.type
      if (type !== "text" && type !== "forum") return []
      return [{
        id: channel.id,
        serverId: server.id,
        categoryId: existing?.categoryId ?? null,
        name: channel.name,
        type,
        parentChannelId: null,
        parentMessageId: null,
        creatorId: existing?.creatorId ?? null,
        position: existing?.position ?? position,
        archived: existing?.archived ?? false,
        muted: existing?.muted ?? false,
        unread: existing?.unread ?? false,
        ...(existing?.baseUnread === undefined ? {} : { baseUnread: existing.baseUnread }),
        tags: existing?.tags ?? [],
        pending: existing?.pending ?? false,
        lastMessageAt: existing?.lastMessageAt ?? null,
      }]
    })
  ))
  notifyManager.batch(() => {
    upsertRows(registry, "servers", serverSchema, (row) => row.id, servers)
    upsertRows(registry, "channels", channelSchema, (row) => row.id, channels)
    if (viewerId) {
      upsertRows(
        registry,
        "serverMemberships",
        serverMembershipSchema,
        (row) => row.id,
        servers.map((server) => ({
          id: serverMembershipKey(server.id, viewerId),
          serverId: server.id,
          userId: viewerId,
          role: server.isOwner ? "owner" : "member",
          viewer: true,
        })),
      )
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        channels.map((channel) => ({
          id: channelMembershipKey(channel.id, viewerId, "access"),
          channelId: channel.id,
          userId: viewerId,
          relation: "access" as const,
          source: "inherited" as const,
        })),
      )
    }
  })
    return "published" as const
  })
}

export type CommunityForumSidebarChannel = {
  id: string
  name: string
  parentChannelId: string | null
  parentMessageId: string | null
  activityAt: string
  unread: boolean
  serverId?: string
  type?: string
  creatorId?: string | null
  archived?: boolean | number
  lastMessageAt?: string | null
  participating?: boolean
}

export type CommunityForumSidebarOpener = {
  id: string
  content: string
  seq?: number
  channelId?: string
  type?: "chat" | "system"
}

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
  assertCommunityLiveSnapshotTokenCurrent(
    queryClient,
    publication.proof.token,
    publication.proof.signal,
  )
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return "no-registry" as const
  return withCanonicalWriteContext(queryClient, {
    kind: "query",
    requestRevision: publication.proof.token.canonicalRevision,
  }, () => {
    const existingById = new Map(
    collectionRows(registry, "channels", channelSchema).map((row) => [row.id, row]),
  )
  const channels: ChannelRow[] = publication.channels.flatMap((channel) => {
    if (!channel.parentChannelId || !channel.parentMessageId) return []
    const existing = existingById.get(channel.id)
    return [{
      id: channel.id,
      serverId: channel.serverId ?? publication.serverId,
      categoryId: null,
      name: channel.name,
      type: "thread" as const,
      parentChannelId: channel.parentChannelId,
      parentMessageId: channel.parentMessageId,
      creatorId: channel.creatorId ?? existing?.creatorId ?? null,
      position: existing?.position ?? 0,
      archived: channel.archived === true || channel.archived === 1,
      muted: existing?.muted ?? false,
      unread: channel.unread,
      tags: existing?.tags ?? [],
      pending: false,
      lastMessageAt: channel.lastMessageAt ?? channel.activityAt,
    }]
  })
  const viewerId = registry.accountId
  notifyManager.batch(() => {
    upsertRows(registry, "channels", channelSchema, (row) => row.id, channels)
    if (viewerId) {
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        channels.map((channel) => ({
          id: channelMembershipKey(channel.id, viewerId, "access"),
          channelId: channel.id,
          userId: viewerId,
          relation: "access" as const,
          source: "explicit" as const,
        })),
      )
      const participating = publication.channels
        .filter((channel) => channel.participating !== false)
        .map((channel) => channel.id)
      upsertRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.id,
        participating.map((channelId) => ({
          id: channelMembershipKey(channelId, viewerId, "notify"),
          channelId,
          userId: viewerId,
          relation: "notify" as const,
          source: "explicit" as const,
        })),
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
      deleteRows(
        registry,
        "channelMemberships",
        channelMembershipSchema,
        (row) => row.channelId === id
          && row.userId === viewerId
          && row.relation === "notify",
      )
      if (disposition === "genuine-negative") {
        patchRows(
          registry,
          "channels",
          channelSchema,
          (row) => row.id,
          (row) => ({ ...row, unread: false }),
          (row) => row.id === id,
        )
      }
    }
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
  return patchRows(
    registry,
    "channels",
    channelSchema,
    (row) => row.id,
    patch,
    (row) => row.id === channelId,
  )
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
      messageSchema,
      (row) => row.id,
      patch,
      (row) => row.id === messageId,
    )
  ))
}

export function removeCanonicalCommunityChannel(
  queryClient: QueryClient,
  channelId: string,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return false
  const exists = collectionRows(registry, "channels", channelSchema)
    .some((row) => row.id === channelId)
  if (exists) purgeCommunityChannel(registry, channelId)
  return exists
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
    channelMembershipSchema,
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
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry?.accountId) return false
  if (!present) {
    return removeCanonicalCommunityChannelMembership(queryClient, channelId, relation)
  }
  upsertRows(
    registry,
    "channelMemberships",
    channelMembershipSchema,
    (row) => row.id,
    [{
      id: channelMembershipKey(channelId, registry.accountId, relation),
      channelId,
      userId: registry.accountId,
      relation,
      source: "explicit",
    }],
  )
  return true
}

export function getCanonicalCommunityChannels(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "channels", channelSchema) : []
}

export function getCanonicalCommunityChannelMemberships(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry
    ? collectionRows(registry, "channelMemberships", channelMembershipSchema)
    : []
}

export function getCanonicalCommunityMessages(queryClient: QueryClient) {
  const registry = getCommunityDbRegistry(queryClient)
  return registry ? collectionRows(registry, "messages", messageSchema) : []
}

export function purgeCommunityServer(registry: CommunityDbRegistry, serverId: string) {
  if (isProtectedFromQueryWrite(registry, "servers", serverId)) return
  const removedChannelIds = new Set(
    collectionRows(registry, "channels", channelSchema)
      .filter((row) => row.serverId === serverId)
      .map((row) => row.id),
  )
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
  useCommunityWsStore.getState().revokeServerAccess(serverId)
  useMessageStreamStore.getState().removeServer(serverId)
  void registry.queryClient.cancelQueries({ queryKey: communityKeys.server(serverId) })
  registry.queryClient.removeQueries({ queryKey: communityKeys.server(serverId) })
  const community = useCommunityStore.getState()
  if (community.currentServerId === serverId) {
    community.setCurrentChannelMeta(null)
    community.setCurrentChannelId(null)
    community.setCurrentServerId(null)
  }
  notifyManager.batch(() => {
    deleteRows(registry, "servers", serverSchema, (row) => row.id === serverId, [serverId])
    deleteRows(registry, "categories", categorySchema, (row) => row.serverId === serverId)
    deleteRows(registry, "channels", channelSchema, (row) => removedChannelIds.has(row.id))
    deleteRows(registry, "serverMemberships", serverMembershipSchema, (row) => row.serverId === serverId)
    deleteRows(registry, "channelMemberships", channelMembershipSchema, (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "messages", messageSchema, (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "readStates", readStateSchema, (row) => removedChannelIds.has(row.channelId))
    deleteRows(registry, "folderItems", folderItemSchema, (row) => row.serverId === serverId)
    deleteRows(registry, "notificationSettings", notificationSettingSchema, (row) => (
      row.serverId === serverId || Boolean(row.channelId && removedChannelIds.has(row.channelId))
    ))
    garbageCollectCommunityProfiles(registry)
  })
}

export function purgeCommunityChannel(registry: CommunityDbRegistry, channelId: string) {
  if (isProtectedFromQueryWrite(registry, "channels", channelId)) return
  const channels = collectionRows(registry, "channels", channelSchema)
  const root = channels.find((row) => row.id === channelId)
  const removed = new Set([
    channelId,
    ...channels
      .filter((row) => row.id === channelId || row.parentChannelId === channelId)
      .map((row) => row.id),
  ])
  clearChannelTransientState(registry, removed, root?.serverId ?? null)
  notifyManager.batch(() => {
    deleteRows(registry, "channels", channelSchema, (row) => removed.has(row.id), [channelId])
    deleteRows(registry, "channelMemberships", channelMembershipSchema, (row) => removed.has(row.channelId))
    deleteRows(registry, "messages", messageSchema, (row) => removed.has(row.channelId))
    deleteRows(registry, "readStates", readStateSchema, (row) => removed.has(row.channelId))
    deleteRows(registry, "notificationSettings", notificationSettingSchema, (row) => (
      Boolean(row.channelId && removed.has(row.channelId))
    ))
    garbageCollectCommunityProfiles(registry)
  })
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
    case "community:message.create":
      ingestMessages(registry, event.channelId, [projectCommunityMessageCreate(event.message)])
      if (event.message.createdAt) {
        patchRows(
          registry,
          "channels",
          channelSchema,
          (row) => row.id,
          (row) => ({ ...row, lastMessageAt: event.message.createdAt }),
          (row) => row.id === event.channelId,
          [event.channelId],
        )
      }
      return
    case "community:message.edited":
      patchRows(
        registry,
        "messages",
        messageSchema,
        (row) => row.id,
        (row) => ({ ...row, content: event.content }),
        (row) => row.id === event.messageId,
        [event.messageId],
      )
      return
    case "community:message.updated":
      patchRows(
        registry,
        "messages",
        messageSchema,
        (row) => row.id,
        (row) => ({ ...row, approval: event.approval }),
        (row) => row.id === event.messageId,
        [event.messageId],
      )
      return
    case "community:reaction.add":
    case "community:reaction.remove":
      patchRows(
        registry,
        "messages",
        messageSchema,
        (row) => row.id,
        (row) => {
          const message = row as MessageRow & Msg
          const reactions = (message.reactions ?? []).map((reaction) => ({
            ...reaction,
            userIds: [...reaction.userIds],
          }))
          const reaction = reactions.find((candidate) => candidate.emoji === event.emoji)
          if (event.type === "community:reaction.add") {
            if (reaction && !reaction.userIds.includes(event.userId)) reaction.userIds.push(event.userId)
            else if (!reaction) reactions.push({
              emoji: event.emoji,
              count: 1,
              me: event.userId === registry.accountId,
              userIds: [event.userId],
            })
          } else if (reaction) {
            reaction.userIds = reaction.userIds.filter((userId) => userId !== event.userId)
          }
          const normalized = reactions
            .filter((candidate) => candidate.userIds.length > 0)
            .map((candidate) => ({
              ...candidate,
              count: candidate.userIds.length,
              me: Boolean(registry.accountId && candidate.userIds.includes(registry.accountId)),
            }))
          return { ...row, reactions: normalized }
        },
        (row) => row.id === event.messageId,
        [event.messageId],
      )
      return
    case "community:channel.child_create": {
      if (!event.parentMessageId) return
      const parent = collectionRows(registry, "channels", channelSchema)
        .find((row) => row.id === event.parentChannelId)
      if (!parent?.serverId) return
      upsertRows(registry, "channels", channelSchema, (row) => row.id, [{
        id: event.channel.id,
        serverId: parent.serverId,
        categoryId: null,
        name: event.channel.name,
        type: "thread",
        parentChannelId: event.parentChannelId,
        parentMessageId: event.parentMessageId,
        creatorId: event.channel.creatorId ?? null,
        position: 0,
        archived: false,
        muted: false,
        unread: false,
        tags: [],
        pending: false,
        lastMessageAt: event.channel.createdAt,
      }])
      if (registry.accountId) {
        upsertRows(
          registry,
          "channelMemberships",
          channelMembershipSchema,
          (row) => row.id,
          [{
            id: channelMembershipKey(event.channel.id, registry.accountId, "access"),
            channelId: event.channel.id,
            userId: registry.accountId,
            relation: "access",
            source: "explicit",
          }],
        )
      }
      return
    }
    case "community:channel.child_update":
      patchRows(
        registry,
        "channels",
        channelSchema,
        (row) => row.id,
        (row) => ({
          ...row,
          ...(event.changes.name === undefined ? {} : { name: event.changes.name }),
          ...(event.changes.archived === undefined ? {} : { archived: event.changes.archived }),
          ...(event.changes.tags === undefined ? {} : { tags: event.changes.tags ?? [] }),
          ...(event.changes.lastMessageAt === undefined ? {} : { lastMessageAt: event.changes.lastMessageAt }),
        }),
        (row) => row.id === event.channelId,
        [event.channelId],
      )
      return
    case "community:server.update":
      patchRows(
        registry,
        "servers",
        serverSchema,
        (row) => row.id,
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.serverId,
        [event.serverId],
      )
      return
    case "community:server.delete":
      purgeCommunityServer(registry, event.serverId)
      return
    case "community:channel.create":
      upsertRows(registry, "channels", channelSchema, (row) => row.id, [{
        id: event.channel.id,
        serverId: event.serverId,
        categoryId: event.channel.categoryId ?? null,
        name: event.channel.name,
        type: event.channel.type,
        parentChannelId: null,
        parentMessageId: null,
        creatorId: null,
        position: event.channel.position,
        archived: false,
        muted: false,
        unread: false,
        tags: [],
        pending: false,
        lastMessageAt: event.channel.createdAt,
      }])
      return
    case "community:channel.update":
      patchRows(
        registry,
        "channels",
        channelSchema,
        (row) => row.id,
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.channelId,
        [event.channelId],
      )
      return
    case "community:channel.delete":
      purgeCommunityChannel(registry, event.channelId)
      return
    case "community:channel.reorder": {
      const positionById = new Map(event.channels.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "channels",
        channelSchema,
        (row) => row.id,
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
      )
      return
    }
    case "community:channel.member_add":
    case "community:channel.member_remove":
      // Relation ownership depends on resolved channel type. The membership
      // handler publishes this only after canonical metadata proves whether
      // the event changes thread notify or top-level access.
      return
    case "community:category.create":
      upsertRows(registry, "categories", categorySchema, (row) => row.id, [{
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
        categorySchema,
        (row) => row.id,
        (row) => ({ ...row, ...event.changes }),
        (row) => row.id === event.categoryId,
        [event.categoryId],
      )
      return
    case "community:category.delete":
      deleteRows(
        registry,
        "categories",
        categorySchema,
        (row) => row.id === event.categoryId,
        [event.categoryId],
      )
      return
    case "community:category.reorder": {
      const positionById = new Map(event.categories.map((row) => [row.id, row.position]))
      patchRows(
        registry,
        "categories",
        categorySchema,
        (row) => row.id,
        (row) => ({ ...row, position: positionById.get(row.id) ?? row.position }),
        (row) => row.serverId === event.serverId && positionById.has(row.id),
        positionById.keys(),
      )
      return
    }
    case "community:member.join":
      upsertRows(registry, "serverMemberships", serverMembershipSchema, (row) => row.id, [{
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
      if (event.userId === registry.accountId) {
        purgeCommunityServer(registry, event.serverId)
      } else {
        deleteRows(
          registry,
          "serverMemberships",
          serverMembershipSchema,
          (row) => row.serverId === event.serverId && row.userId === event.userId,
        )
      }
      return
    case "community:member.update":
      patchRows(
        registry,
        "serverMemberships",
        serverMembershipSchema,
        (row) => row.id,
        (row) => ({ ...row, ...event.changes }),
        (row) => row.serverId === event.serverId
          && (row.memberId === event.memberId || Boolean(event.userId && row.userId === event.userId)),
      )
      return
    case "community:unread.bump":
      if (event.userId !== registry.accountId) return
      patchRows(
        registry,
        "channels",
        channelSchema,
        (row) => row.id,
        (row) => ({ ...row, unread: true }),
        (row) => row.id === event.channelId || row.id === event.railChannelId,
        [event.channelId, event.railChannelId]
          .filter((channelId): channelId is string => Boolean(channelId)),
      )
      if (event.serverId) {
        patchRows(
          registry,
          "servers",
          serverSchema,
          (row) => row.id,
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
  void registry.preload()
  return () => {}
}
