import { notifyManager, type QueryClient } from "@tanstack/react-query"
import type { InfiniteData, Query } from "@tanstack/react-query"
import { UNCATEGORIZED_CATEGORY_ID, type CommunityWsEvent } from "@alook/shared"
import type { DmsResponse } from "@/hooks/community/use-dms"
import type { FoldersResponse } from "@/hooks/community/use-folders"
import type {
  AccountReadStateSnapshot,
} from "@/hooks/community/community-ws/read-state-reconciliation"
import type { ServerDetail, ServersResponse } from "@/hooks/community/use-servers"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import type { NotificationSettings } from "@/hooks/community/use-notification-settings"
import { communityKeys } from "@/lib/query-keys"
import {
  communityUserProfilePatch,
  messageProfilePatches,
  writeCommunityProfilePatches,
} from "@/lib/community/profile-seed"
import type { CommunityProfilePatch } from "@/lib/community/models/people"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"
import { useMessageStreamStore } from "@/stores/community/message-stream"
import { clearTypingIndicator } from "@/hooks/community/community-ws/typing"
import { getAccountUnreadProjection } from "@/hooks/community/account-unread-projection"
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
  const nextByKey = new Map(current.filter((row) => !owns(row)).map((row) => [getKey(row), row]))
  for (const row of parsedIncoming) nextByKey.set(getKey(row), row)
  const next = [...nextByKey.values()]
  writeCollectionRows(registry, name, next, getKey)
  publishRows(registry, name, next)
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
  for (const row of parsedIncoming) nextByKey.set(getKey(row), row)
  const next = [...nextByKey.values()]
  writeCollectionRows(registry, name, next, getKey)
  publishRows(registry, name, next)
}

function patchRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  getKey: (row: T) => string,
  patch: (row: T) => T,
  matches: (row: T) => boolean,
) {
  const current = collectionRows(registry, name, schema)
  let changed = false
  const next = current.map((row) => {
    if (!matches(row)) return row
    changed = true
    return schema.parse(patch(row))
  })
  if (!changed) return false
  writeCollectionRows(registry, name, next, getKey)
  publishRows(registry, name, next)
  return true
}

function deleteRows<T extends object>(
  registry: CommunityDbRegistry,
  name: CollectionName,
  schema: z.ZodType<T>,
  remove: (row: T) => boolean,
) {
  const current = collectionRows(registry, name, schema)
  const next = current.filter((row) => !remove(row))
  const keyByValue = new Map(current.map((row) => [row, (
    registry.collections[name] as unknown as { getKeyFromItem: (value: T) => string }
  ).getKeyFromItem(row)]))
  writeCollectionRows(registry, name, next, (row) => keyByValue.get(row) ?? (
    registry.collections[name] as unknown as { getKeyFromItem: (value: T) => string }
  ).getKeyFromItem(row))
  publishRows(registry, name, next)
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
) {
  const incomingServerIds = new Set(response.servers.map((server) => server.id))
  const removedServerIds = collectionRows(registry, "servers", serverSchema)
    .filter((server) => !incomingServerIds.has(server.id))
    .map((server) => server.id)
  const servers: ServerRow[] = response.servers.map((server) => ({
    id: server.id,
    name: server.name,
    discriminator: server.discriminator ?? "",
    description: server.description ?? "",
    ownerId: server.ownerId ?? "",
    icon: server.icon ?? null,
    official: server.official === true,
    isOwner: server.isOwner === true,
    unread: server.unread,
    mentions: server.mentions,
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
    for (const serverId of removedServerIds) purgeCommunityServer(registry, serverId)
    replaceRows(registry, "servers", serverSchema, (row) => row.id, servers, () => true)
    if (viewerId) {
      replaceRows(
        registry,
        "serverMemberships",
        serverMembershipSchema,
        (row) => row.id,
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
  const existing = collectionRows(registry, "servers", serverSchema)
    .find((row) => row.id === detail.id)
  const server: ServerRow = {
    id: detail.id,
    name: detail.name,
    discriminator: detail.discriminator,
    description: detail.description,
    ownerId: detail.ownerId,
    icon: detail.icon,
    official: detail.official === true,
    isOwner: existing?.isOwner ?? detail.ownerId === registry.accountId,
    unread: existing?.unread ?? false,
    mentions: existing?.mentions ?? 0,
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
  const authoritativeTopLevelIds = new Set([...currentTopLevelIds, ...incomingTopLevelIds])
  notifyManager.batch(() => {
    for (const channelId of removedTopLevelIds) purgeCommunityChannel(registry, channelId)
    upsertRows(registry, "servers", serverSchema, (row) => row.id, [server])
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
    if (viewerId) {
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
    }
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
    tags: existing?.tags ?? [],
    pending: false,
    lastMessageAt: metadata.lastMessageAt,
  }])
}

export function ingestDms(registry: CommunityDbRegistry, response: DmsResponse) {
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
    writeCommunityProfilePatches(profilePatches, registry)
  })
}

function ingestFolders(registry: CommunityDbRegistry, response: FoldersResponse) {
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
    replaceRows(registry, "folders", folderSchema, (row) => row.id, folders, () => true)
    replaceRows(registry, "folderItems", folderItemSchema, (row) => row.id, items, () => true)
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
) {
  const currentRevision = collectionRows(registry, "readStateClock", readStateClockSchema)
    .find((row) => row.id === "account")?.revision ?? -1
  if (snapshot.revision <= currentRevision) return
  const readStates: ReadStateRow[] = snapshot.readStates.map((row) => ({ ...row }))
  const clock: ReadStateClockRow = { id: "account", revision: snapshot.revision }
  notifyManager.batch(() => {
    replaceRows(registry, "readStates", readStateSchema, (row) => row.channelId, readStates, () => true)
    replaceRows(registry, "readStateClock", readStateClockSchema, (row) => row.id, [clock], () => true)
  })
}

function ingestNotificationSettings(
  registry: CommunityDbRegistry,
  settings: NotificationSettings,
) {
  const rows: NotificationSettingRow[] = settings.raw.flatMap((row) => {
    if (Boolean(row.serverId) === Boolean(row.channelId)) return []
    const target = { serverId: row.serverId ?? null, channelId: row.channelId ?? null }
    return [{ id: notificationSettingKey(target), ...target, level: row.level }]
  })
  replaceRows(
    registry,
    "notificationSettings",
    notificationSettingSchema,
    (row) => row.id,
    rows,
    () => true,
  )
}

export function purgeCommunityServer(registry: CommunityDbRegistry, serverId: string) {
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
    deleteRows(registry, "servers", serverSchema, (row) => row.id === serverId)
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
    deleteRows(registry, "channels", channelSchema, (row) => removed.has(row.id))
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
 * fetch invalidation; those successful HTTP responses flow back through
 * `installCommunityDbSync` and authoritatively replace the same rows.
 */
export function projectCommunityWsEventToDb(
  queryClient: QueryClient,
  event: CommunityWsEvent,
) {
  const registry = getCommunityDbRegistry(queryClient)
  if (!registry) return
  switch (event.type) {
    case "community:message.create":
      ingestMessages(registry, event.channelId, [event.message as Msg])
      return
    case "community:message.edited":
      patchRows(
        registry,
        "messages",
        messageSchema,
        (row) => row.id,
        (row) => ({ ...row, content: event.content }),
        (row) => row.id === event.messageId,
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
      return
    }
    case "community:channel.child_update":
      if (event.changes.archived === true) {
        purgeCommunityChannel(registry, event.channelId)
        return
      }
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
      )
      return
    }
    case "community:channel.member_add":
      upsertRows(registry, "channelMemberships", channelMembershipSchema, (row) => row.id, [{
        id: channelMembershipKey(event.channelId, event.userId, "access"),
        channelId: event.channelId,
        userId: event.userId,
        relation: "access",
        source: "explicit",
      }])
      return
    case "community:channel.member_remove":
      if (event.userId === registry.accountId) {
        purgeCommunityChannel(registry, event.channelId)
      } else {
        deleteRows(
          registry,
          "channelMemberships",
          channelMembershipSchema,
          (row) => row.channelId === event.channelId
            && row.userId === event.userId
            && row.relation === "access",
        )
      }
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
      )
      return
    case "community:category.delete":
      deleteRows(registry, "categories", categorySchema, (row) => row.id === event.categoryId)
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
}

function messagesFromInfiniteData(data: unknown): Msg[] {
  const pages = (data as InfiniteData<MessagesPage> | undefined)?.pages
  if (!Array.isArray(pages)) return []
  const byId = new Map<string, Msg>()
  for (const page of pages) {
    for (const message of page.messages ?? []) byId.set(message.id, message)
  }
  return [...byId.values()]
}

function ingestScopedMessages(
  registry: CommunityDbRegistry,
  entries: readonly { channelId: string; message: Msg }[],
) {
  const byChannel = new Map<string, Msg[]>()
  for (const { channelId, message } of entries) {
    const messages = byChannel.get(channelId) ?? []
    messages.push(message)
    byChannel.set(channelId, messages)
  }
  for (const [channelId, messages] of byChannel) ingestMessages(registry, channelId, messages)
}

function forumMessagesFromData(data: unknown) {
  const pages = (data as InfiniteData<{
    included?: { parentMessages?: Array<Record<string, unknown>> }
  }> | undefined)?.pages
  if (!Array.isArray(pages)) return []
  return pages.flatMap((page) => (page.included?.parentMessages ?? []).flatMap((raw) => {
    if (typeof raw.id !== "string" || typeof raw.channelId !== "string") return []
    return [{
      channelId: raw.channelId,
      message: {
        ...raw,
        type: "chat",
        authorAvatar: typeof raw.authorImage === "string" ? raw.authorImage : "",
      } as Msg,
    }]
  }))
}

function ingestSuccessfulQuery(registry: CommunityDbRegistry, query: Query) {
  if (query.state.status !== "success") return
  const key = query.queryKey
  if (key[0] !== "community" || key[1] === "db") return
  const data = query.state.data
  if (key.length === 2 && key[1] === "servers") {
    ingestServers(registry, data as ServersResponse)
    return
  }
  if (key.length === 2 && key[1] === "folders") {
    ingestFolders(registry, data as FoldersResponse)
    return
  }
  if (key.length === 2 && key[1] === "dms") {
    ingestDms(registry, data as DmsResponse)
    return
  }
  if (key.length === 3 && key[1] === "servers" && typeof key[2] === "string") {
    ingestServerDetail(registry, data as ServerDetail)
    return
  }
  if (key.includes("channel-meta") && data && typeof data === "object") {
    ingestChannelMetadata(registry, data as Parameters<typeof ingestChannelMetadata>[1])
    return
  }
  if ((key[1] === "channel" || key[1] === "dm") && key.at(-1) === "messages") {
    const channelId = typeof key[2] === "string" ? key[2] : null
    if (channelId) ingestMessages(registry, channelId, messagesFromInfiniteData(data))
    return
  }
  if (key[1] === "channel" && typeof key[2] === "string" && key.at(-1) === "pins") {
    const pins = (data as { pins?: Msg[] } | undefined)?.pins ?? []
    ingestMessages(registry, key[2], pins)
    return
  }
  if (key[1] === "message-context" && typeof key[3] === "string") {
    const messages = (data as { messages?: Msg[] } | undefined)?.messages ?? []
    ingestMessages(registry, key[3], messages)
    return
  }
  if (key[1] === "inbox" && key[2] === "mentions") {
    const mentions = (data as { mentions?: Array<{ channelId?: string; m: Msg }> } | undefined)
      ?.mentions ?? []
    ingestScopedMessages(registry, mentions.flatMap((mention) => (
      mention.channelId ? [{ channelId: mention.channelId, message: mention.m }] : []
    )))
    return
  }
  if (key[1] === "inbox" && key[2] === "marked") {
    const marked = (data as { marked?: Array<{ channelId: string; m: Msg }> } | undefined)
      ?.marked ?? []
    ingestScopedMessages(registry, marked.map((entry) => ({
      channelId: entry.channelId,
      message: entry.m,
    })))
    return
  }
  if (key[1] === "channel" && key[3] === "threads" && key[4] === "feed") {
    ingestScopedMessages(registry, forumMessagesFromData(data))
    return
  }
  if (key[1] === "message" && key.length === 3 && data && typeof data === "object") {
    const message = data as Msg
    const existing = collectionRows(registry, "messages", messageSchema)
      .find((row) => row.id === message.id)
    const inferredChannelId = existing?.channelId ?? collectionRows(
      registry,
      "channels",
      channelSchema,
    ).find((row) => row.parentMessageId === message.id)?.parentChannelId
    if (inferredChannelId) ingestMessages(registry, inferredChannelId, [message])
    return
  }
  if (key.length === 2 && key[1] === "read-state-snapshot") {
    ingestReadStateSnapshot(registry, data as AccountReadStateSnapshot)
    return
  }
  if (key.length === 2 && key[1] === "notification-settings") {
    ingestNotificationSettings(registry, data as NotificationSettings)
  }
}

export function installCommunityDbSync(
  queryClient: QueryClient,
  registry: CommunityDbRegistry,
) {
  let disposed = false
  const ingestAll = () => {
    if (disposed) return
    for (const query of queryClient.getQueryCache().getAll()) {
      ingestSuccessfulQuery(registry, query)
    }
  }
  void registry.preload().then(ingestAll)
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (disposed || event.type !== "updated") return
    ingestSuccessfulQuery(registry, event.query)
  })
  return () => {
    disposed = true
    unsubscribe()
  }
}
