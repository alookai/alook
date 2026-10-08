"use client"

import { createContext, createElement, useContext, useMemo, type Context, type ReactNode } from "react"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import { DbProvider, collectionOptions, getLiveQueryHash, liveQueryCollectionOptions, prepareLiveQueryValue, and, eq, inArray, useLiveQuery as useNativeLiveQuery, type Context as QueryContext, type LiveQueryCollectionConfig, type WhereCallback, type ContextFromSource } from "@tanstack/react-db"
import { createStore, useSelector } from "@tanstack/react-store"
import { CommunityRuntimeProvider } from "@/stores/community/runtime"
import { notifLevelDisplay } from "@alook/shared"
import { projectForumSidebar } from "@/lib/community/forum-sidebar"
import { avatarInitial } from "@/lib/community/avatar"
import type { DM } from "@/lib/community/models/people"
import { sortDmsByActivity } from "@/lib/community/dm-order"
import type { CommunityProfile } from "@/lib/community/models/people"
import type { Category, CommunityFolder, Server } from "@/lib/community/models/navigation"
import type { Msg } from "@/lib/community/models/message"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type { CommunityDbRegistry } from "./collections"
import { useCommunityPreviewProfiles } from "@/stores/community/profile-preview"
import { MAX_PERSISTED_MESSAGES_PER_SCOPE } from "@/lib/query-persister"
import { collectionEvidence, deriveView, sourceEvidence, tagView, viewEvidence } from "@/lib/observability/data-source"

import type {
  CommunityCollectionName,
  CommunityCollectionRows,
  AttentionItemRow,
  AttentionScopeRow,
  ChannelRow,
  FolderItemRow,
  MessageRow,
  ServerRow,
} from "./schema"

function annotateRows<T extends object>(registry: CommunityDbRegistry | null, collection: string, rows: T[] | undefined): T[] | undefined {
  if (!registry || !rows) return rows
  const key = (row: T) => String((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).userId ?? (row as Record<string, unknown>).scopeId)
  for (const row of rows) tagView(row, collectionEvidence(registry.queryClient, collection, [key(row)], [row]))
  return tagView(rows, collectionEvidence(registry.queryClient, collection, rows.map(key), rows))
}

const presenceVersions = new WeakMap<CommunityDbRegistry, Map<string, { value: string; token: object }>>()
function presenceVersion(registry: CommunityDbRegistry, userId: string, value: string) {
  let entries = presenceVersions.get(registry)
  if (!entries) { entries = new Map(); presenceVersions.set(registry, entries) }
  const old = entries.get(userId)
  const token = old?.value === value ? old.token : {}
  entries.set(userId, { value, token })
  if (entries.size > 2048) entries.delete(entries.keys().next().value!)
  return sourceEvidence(token, "ws")
}

function projectedMessage(registry: CommunityDbRegistry | null, message: MessageRow, child?: ChannelRow): Msg {
  const { channelId: _channelId, replyToId: _replyToId, ...model } = message
  const value = { ...model, ...(child ? { thread: { id: child.id, name: child.name, messageCount: child.messageCount ?? 0, lastReplyAt: child.lastMessageAt ?? undefined, tags: child.tags, preview: child.preview, participantCount: child.participantCount } } : {}) } as Msg
  return registry ? deriveView(value, [collectionEvidence(registry.queryClient, "messages", [message.id], [message]), ...(child ? [collectionEvidence(registry.queryClient, "channels", [child.id], [child])] : [])]) : value
}

let communityDbContext: Context<CommunityDbRegistry | null> | null = null

function getCommunityDbContext() {
  communityDbContext ??= createContext<CommunityDbRegistry | null>(null)
  return communityDbContext
}

export function useOptionalCommunityDbRegistry() {
  return useContext(getCommunityDbContext())
}

const useLiveQuery = ((options: unknown) => {
  const registry = useOptionalCommunityDbRegistry()
  const prepared = prepareLiveQueryValue(options, registry?.dbClient, new Set())
  const identity = getLiveQueryHash(prepared)
  const collection = useMemo(() => registry && prepared
    ? registry.dbClient.collection(collectionOptions(`community-live:${identity}`, () => liveQueryCollectionOptions({ ...(prepared as LiveQueryCollectionConfig<QueryContext, Record<string, unknown>>), id: `community-live:${identity}` })))
    : undefined, [registry, prepared, identity])
  return useNativeLiveQuery(() => collection)
}) as typeof useNativeLiveQuery

const absentPresence = createStore({ presenceByUserId: new Map<string, "online" | "offline">() })
const absentRestoration = createStore({ captured: false, names: new Set<string>(), hasData: false })

export function useTrustedRestoredPrimary() {
  const registry = useOptionalCommunityDbRegistry()
  return useSelector(registry?.restoration ?? absentRestoration, (state) => state.names.has("categories") && state.names.has("channels"))
}

export function useTrustedRestoredForumProjection() {
  const registry = useOptionalCommunityDbRegistry()
  return useSelector(registry?.restoration ?? absentRestoration, (state) => ["channels", "channelMemberships", "messages"].every((name) => state.names.has(name)))
}

export function CommunityDbProvider({
  registry,
  children,
}: {
  registry: CommunityDbRegistry
  children?: ReactNode
}) {
  const application = useMemo(() => {
    const owner = createApplicationOwner(registry.accountId ?? "__guest__", registry.queryClient)
    owner.lifecycle = registry.runtime.lifecycle
    owner.bindAuthentication(() => registry.sessionViewer(), () => registry.retireDisk())
    return owner
  }, [registry])
  return createElement(
    ApplicationOwnerProvider, { owner: application },
    createElement(DbProvider, { client: registry.dbClient },
      createElement(getCommunityDbContext().Provider, { value: registry },
        createElement(CommunityRuntimeProvider, { value: { runtime: registry.runtime } }, children))),
  )
}

type CollectionWhere<N extends CommunityCollectionName> = WhereCallback<ContextFromSource<{ row: CommunityDbRegistry["collections"][N] }>>

function useCollectionQuery<N extends CommunityCollectionName>(name: N, where?: CollectionWhere<N>, enabled = true) {
  const registry = useOptionalCommunityDbRegistry()
  const data = useLiveQuery({
    query: (q) => {
      if (!registry || !enabled) return undefined
      const query = q.from({ row: registry.collections[name] })
      return where ? query.where(where) : query
    },
  }).data as CommunityCollectionRows[N][] | undefined
  return { registry, data }
}

function useCollectionRows<N extends CommunityCollectionName>(name: N, where?: CollectionWhere<N>) {
  const { registry, data } = useCollectionQuery(name, where)
  return annotateRows(registry, name, data)
}

function useServerRows(serverId?: string) {
  return useCollectionRows("servers", ({ row }) => serverId === undefined ? eq(1, 1) : eq(row.id, serverId))
}
function useCategoryRows(serverId?: string) {
  return useCollectionRows("categories", ({ row }) => serverId === undefined ? eq(1, 1) : eq(row.serverId, serverId))
}
function useServerMembershipRows() { return useCollectionRows("serverMemberships") }
function useFolderRows() { return useCollectionRows("folders") }
function useFolderItemRows() { return useCollectionRows("folderItems") }
function useNotificationSettingRows() { return useCollectionRows("notificationSettings") }
function useChannelRows(serverId?: string, type?: ChannelRow["type"]) {
  return useCollectionRows("channels", ({ row }) => and(
    serverId === undefined ? eq(1, 1) : eq(row.serverId, serverId),
    type === undefined ? eq(1, 1) : eq(row.type, type),
  ))
}
function useChannelMembershipRows(channelIds?: string[]) {
  return useCollectionRows("channelMemberships", ({ row }) => channelIds === undefined ? eq(1, 1) : inArray(row.channelId, channelIds))
}
function useMessageRowsById(messageIds: string[]) {
  return useCollectionRows("messages", ({ row }) => inArray(row.id, messageIds))
}

export function useServerRailProjection() {
  const rows = {
    registry: useOptionalCommunityDbRegistry(),
    servers: useServerRows(),
    serverMemberships: useServerMembershipRows(),
    folders: useFolderRows(),
    folderItems: useFolderItemRows(),
  }
  return useMemo(() => {
    if (!rows.registry || !rows.servers || !rows.serverMemberships) return undefined
    const viewerId = rows.registry.accountId
    const allowed = new Set(
      rows.serverMemberships
        .filter((membership) => membership.viewer && membership.userId === viewerId)
        .map((membership) => membership.serverId),
    )
    const servers: Server[] = rows.servers
      .map((server, fallbackPosition) => ({ server, fallbackPosition }))
      .sort((left, right) => (
        (left.server.position ?? left.fallbackPosition)
        - (right.server.position ?? right.fallbackPosition)
      ))
      .filter(({ server }) => allowed.has(server.id))
      .map(({ server }) => ({
        id: server.id,
        name: server.name,
        discriminator: server.discriminator,
        description: server.description,
        ownerId: server.ownerId,
        initial: avatarInitial(server.name),
        active: false,
        unread: server.unread,
        mentions: server.mentions,
        official: server.official,
        isOwner: server.isOwner,
        icon: server.icon,
      }))
    const byServer = new Map(servers.map((server) => [server.id, server]))
    const itemsByFolder = new Map<string, FolderItemRow[]>()
    for (const item of rows.folderItems ?? []) {
      const items = itemsByFolder.get(item.folderId) ?? []
      items.push(item)
      itemsByFolder.set(item.folderId, items)
    }
    const folders: CommunityFolder[] = (rows.folders ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
        position: folder.position,
        servers: (itemsByFolder.get(folder.id) ?? [])
          .slice()
          .sort((a, b) => a.position - b.position)
          .flatMap((item) => {
            const server = byServer.get(item.serverId)
            return server ? [{
              id: server.id,
              name: server.name,
              initial: server.initial,
              icon: server.icon,
            }] : []
          }),
      }))
    deriveView(servers, [
      collectionEvidence(rows.registry.queryClient, "servers", rows.servers.map(row => row.id), rows.servers),
      collectionEvidence(rows.registry.queryClient, "serverMemberships", rows.serverMemberships.map(row => row.id), rows.serverMemberships),
    ])
    deriveView(folders, [
      viewEvidence(servers),
      collectionEvidence(rows.registry.queryClient, "folders", (rows.folders ?? []).map(row => row.id), rows.folders ?? []),
      collectionEvidence(rows.registry.queryClient, "folderItems", (rows.folderItems ?? []).map(row => row.id), rows.folderItems ?? []),
    ])
    return deriveView({ servers, folders }, [viewEvidence(servers), viewEvidence(folders)], servers.length + folders.length)
  }, [rows.registry, rows.servers, rows.serverMemberships, rows.folders, rows.folderItems])
}

export function useServerTreeProjection(serverId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const rows = {
    servers: useServerRows(serverId ?? ""),
    categories: useCategoryRows(serverId ?? ""),
    channels: useChannelRows(serverId ?? ""),
  }
  return useMemo(() => {
    if (!serverId || !rows.servers || !rows.categories || !rows.channels) return undefined
    const server = rows.servers.find((candidate) => candidate.id === serverId)
    if (!server?.detailComplete) return undefined
    const channels = rows.channels.filter((channel) => (
      channel.serverId === serverId && channel.type !== "thread"
    ))
    const channelView = (channel: ChannelRow): Category["channels"][number] => ({
      id: channel.id,
      name: channel.name,
      active: false,
      unread: channel.unread,
      muted: channel.muted,
      type: channel.type === "forum" ? "forum" : "text",
      tags: channel.tags,
      creatorId: channel.creatorId,
      pending: channel.pending,
    })
    const categories: Category[] = rows.categories
      .filter((category) => category.serverId === serverId)
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        id: category.id,
        name: category.name,
        private: category.private,
        creatorId: category.creatorId,
        pending: category.pending,
        channels: channels
          .filter((channel) => channel.categoryId === category.id)
          .sort((a, b) => a.position - b.position)
          .map(channelView),
      }))
    const uncategorized = channels
      .filter((channel) => !channel.categoryId)
      .sort((a, b) => a.position - b.position)
      .map(channelView)
    if (uncategorized.length > 0) {
      categories.push({ id: "__uncategorized__", name: "", private: false, channels: uncategorized })
    }
    if (registry) deriveView(categories, [collectionEvidence(registry.queryClient, "categories", rows.categories.map(row => row.id), rows.categories), collectionEvidence(registry.queryClient, "channels", channels.map(row => row.id), channels)], channels.length)
    const view = {
      id: server.id, name: server.name, discriminator: server.discriminator,
      description: server.description, icon: server.icon, official: server.official,
      ownerId: server.ownerId, categories,
    }
    return registry ? deriveView(view, [
      collectionEvidence(registry.queryClient, "servers", [server.id], [server]),
      collectionEvidence(registry.queryClient, "categories", rows.categories.map(row => row.id), rows.categories),
      collectionEvidence(registry.queryClient, "channels", channels.map(row => row.id), channels),
    ], channels.length) : view
  }, [rows.servers, rows.categories, rows.channels, serverId, registry])
}

export function useDmProjection() {
  const registry = useOptionalCommunityDbRegistry()
  const channels = useChannelRows(undefined, "dm")
  const channelIds = useMemo(() => (channels ?? []).map((channel) => channel.id), [channels])
  const channelMemberships = useChannelMembershipRows(channelIds)
  const userIds = useMemo(() => (channelMemberships ?? []).filter((membership) => (
    membership.relation === "access" && membership.userId !== registry?.accountId
  )).map((membership) => membership.userId), [channelMemberships, registry?.accountId])
  const profiles = useCollectionQuery("profiles", ({ row }) => inArray(row.userId, userIds)).data
  const readStates = useCollectionQuery("readStates", ({ row }) => inArray(row.channelId, channelIds)).data
  const rows = { registry, channels, channelMemberships, profiles, readStates }
  return useMemo(() => {
    const viewerId = rows.registry?.accountId
    if (!viewerId || !rows.channels || !rows.channelMemberships || !rows.profiles) return undefined
    const channelMemberships = rows.channelMemberships
    const profileById = new Map(rows.profiles.map((profile) => [profile.userId, profile]))
    const readStateByChannel = new Map((rows.readStates ?? []).map((state) => [state.channelId, state]))
    const result = sortDmsByActivity(rows.channels
      .filter((channel) => channel.type === "dm")
      .flatMap((channel): DM[] => {
        const peerMembership = channelMemberships.find((membership) => (
          membership.channelId === channel.id
          && membership.relation === "access"
          && membership.userId !== viewerId
        ))
        if (!peerMembership) return []
        const profile = profileById.get(peerMembership.userId)
        if (!profile) return []
        const readState = readStateByChannel.get(channel.id)
        return [{
          id: channel.id,
          userId: profile.userId,
          name: profile.name,
          discriminator: profile.discriminator,
          avatar: profile.avatar,
          avatarVersion: profile.avatarVersion,
          status: "offline",
          preview: channel.preview ?? "",
          ...(channel.lastMessageAt ? { activityAt: channel.lastMessageAt } : {}),
          unread: channel.unread,
          ...(channel.lastUnreadSeq === undefined && !readState
            ? {}
            : { lastUnreadSeq: channel.lastUnreadSeq ?? readState?.lastReadSeq }),
        }]
      }))
    return deriveView(result, [viewEvidence(rows.channels), viewEvidence(rows.channelMemberships), collectionEvidence(rows.registry!.queryClient, "profiles", rows.profiles.map(row => row.userId), rows.profiles), collectionEvidence(rows.registry!.queryClient, "readStates", (rows.readStates ?? []).map(row => row.channelId), rows.readStates)])
  }, [rows.registry, rows.channels, rows.channelMemberships, rows.profiles, rows.readStates])
}

export function useRouteChannelProjection(channelId: string | null) {
  const result = useCollectionQuery("channels", ({ row }) => eq(row.id, channelId ?? ""))
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return result.data.find((row) => row.id === channelId)
  }, [channelId, result.data])
}

function useJoinedMessageQuery(channelId: string | null | undefined, ids?: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry && (channelId === undefined || !!channelId)
      ? q.from({ message: registry.collections.messages }).where(({ message }) => channelId === undefined ? eq(1, 1) : eq(message.channelId, channelId))
        .where(({ message }) => ids === undefined ? eq(1, 1) : inArray(message.id, [...ids]))
        .leftJoin({ child: registry.collections.channels }, ({ message, child }) => eq(message.id, child.parentMessageId))
        .select(({ message, child }) => ({ message, child }))
      : undefined,
  })
  return { registry, data: result.data as Array<{ message: MessageRow; child?: ChannelRow }> | undefined }
}

export function useMessageProjection(channelId: string | null, ids?: readonly string[]) {
  const { registry, data } = useJoinedMessageQuery(channelId, ids)
  return useMemo(() => {
    if (!channelId || !data) return undefined
    const messages = data
      .sort((a, b) => (a.message.seq ?? 0) - (b.message.seq ?? 0))
      .map(({ message, child }) => {
        return projectedMessage(registry, message, child)
      })
    return deriveView(messages, messages.map(viewEvidence))
  }, [channelId, data, registry])
}

export function useCanonicalMessagesById(ids?: readonly string[]): ReadonlyMap<string, Msg> | undefined {
  const { registry, data } = useJoinedMessageQuery(undefined, ids)
  return useMemo(() => !registry ? undefined : new Map(
    (data ?? []).map(({ message, child }) => {
      return [message.id, projectedMessage(registry, message, child)]
    }),
  ), [registry, data])
}

export function useMessageWindowProjection(channelId: string | null, ids: readonly string[] | undefined, liveIds: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  const warm = useLiveQuery({ query: (q) => registry && channelId && ids === undefined
    ? q.from({ message: registry.collections.messages }).where(({ message }) => eq(message.channelId, channelId))
      .orderBy(({ message }) => message.seq, "desc").orderBy(({ message }) => message.id, "desc")
      .limit(MAX_PERSISTED_MESSAGES_PER_SCOPE).select(({ message }) => ({ id: message.id }))
    : undefined }).data as Array<{ id: string }> | undefined
  const selected = useMemo(() => ids ?? warm?.map((message) => message.id) ?? [], [ids, warm])
  const allIds = useMemo(() => [...new Set([...selected, ...liveIds])], [selected, liveIds])
  const messages = useMessageProjection(channelId, allIds)
  return { messages, windowIds: selected }
}

function useCollectionById<N extends "channels" | "servers">(name: N) {
  const rows = useCollectionRows(name)
  return useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows])
}

export function useCanonicalChannelsById(): ReadonlyMap<string, ChannelRow> { return useCollectionById("channels") }

export function useFriendshipRows(ids?: readonly string[]) {
  return useCollectionQuery("friendships", ({ row }) => ids === undefined ? eq(1, 1) : inArray(row.id, [...ids])).data ?? []
}

export function useCanonicalServersById(): ReadonlyMap<string, ServerRow> { return useCollectionById("servers") }

export function useCanonicalCommunityServer(serverId: string | null | undefined) {
  return useServerRows(serverId ?? "__inactive__")?.[0]
}

export function materializeCanonicalMessage(
  transport: Pick<Msg, "id">,
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg | undefined {
  return canonical === undefined ? transport as Msg : canonical.get(transport.id)
}

export function materializeCanonicalMessages(
  transport: readonly Pick<Msg, "id">[],
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg[] {
  return canonical === undefined
    ? [...transport] as Msg[]
    : transport.flatMap((message) => {
        const row = canonical.get(message.id)
        return row ? [row] : []
      })
}

export function useNotificationSettingsProjection() {
  const rows = { notificationSettings: useNotificationSettingRows() }
  return useMemo(() => {
    if (!rows.notificationSettings) return undefined
    const server: Record<string, string> = {}
    const channel: Record<string, string> = {}
    for (const setting of rows.notificationSettings) {
      const display = notifLevelDisplay(setting.level)
      if (setting.channelId) channel[setting.channelId] = display
      else if (setting.serverId) server[setting.serverId] = display
    }
    return {
      raw: rows.notificationSettings.map(({ serverId, channelId, level }) => ({
        serverId,
        channelId,
        level,
      })),
      server,
      channel,
    }
  }, [rows.notificationSettings])
}

function useProfileProjectionMap(userIds?: readonly string[]) {
  const result = useCollectionQuery("profiles", ({ row }) => userIds === undefined ? eq(1, 1) : inArray(row.userId, [...userIds]))
  return useMemo(() => new Map(
    (result.data ?? []).map((profile) => [profile.userId, profile]),
  ), [result.data])
}

export function useCanonicalProfilesByUserId(userIds?: readonly string[]): ReadonlyMap<string, CommunityProfile> {
  const previewProfiles = useCommunityPreviewProfiles()
  const canonicalProfiles = useProfileProjectionMap(userIds)
  const registry = useOptionalCommunityDbRegistry()
  const livePresence = useSelector(registry?.runtime.ws ?? absentPresence, (state) => previewProfiles ? null : userIds === undefined ? [...state.presenceByUserId] : userIds.map((id) => [id, state.presenceByUserId.get(id)] as const), { compare: (left, right) => left === right || (!!left && !!right && left.length === right.length && left.every(([id, presence], index) => id === right[index]?.[0] && presence === right[index]?.[1])) })
  return useMemo(() => {
    if (previewProfiles) return previewProfiles
    const merged = new Map<string, CommunityProfile>()
    for (const [userId, profile] of canonicalProfiles) {
      merged.set(userId, registry ? deriveView({ ...profile, id: userId }, [collectionEvidence(registry.queryClient, "profiles", [userId], [profile])]) : { ...profile, id: userId })
    }
    for (const [userId, presence] of livePresence ?? []) {
      if (presence === undefined) continue
      const prior = merged.get(userId)
      const value = { ...prior, id: userId, presence }
      const presenceEvidence = registry ? presenceVersion(registry, userId, presence) : viewEvidence(value)
      merged.set(userId, deriveView(value, [...(prior ? [viewEvidence(prior)] : []), presenceEvidence]))
    }
    return merged
  }, [canonicalProfiles, livePresence, previewProfiles, registry])
}

export function useServerMemberRows(serverId: string | null, userIds: readonly string[]) {
  const { registry, data } = useCollectionQuery("serverMemberships", ({ row }) => and(eq(row.serverId, serverId), inArray(row.userId, [...userIds])), !!serverId)
  return annotateRows(registry, "serverMemberships", data ?? [])!
}

export function useChannelRosterRows(channelId: string, relation: "access" | "notify") {
  const { registry, data } = useCollectionQuery("channelMemberships", ({ row }) => and(eq(row.channelId, channelId), eq(row.relation, relation)), !!channelId)
  return annotateRows(registry, "channelMemberships", data ?? [])!
}

export function useCanonicalCommunityProfile(userId: string | null | undefined) {
  const preview = useCommunityPreviewProfiles()
  const { registry, data } = useCollectionQuery("profiles", ({ row }) => eq(row.userId, userId), !!userId)
  const profile = data?.[0]
  const presence = useSelector(registry?.runtime.ws ?? absentPresence, (state) => userId ? state.presenceByUserId.get(userId) : undefined)
  return useMemo(() => {
    if (!userId) return undefined
    if (preview) return preview.get(userId)
    if (!profile && !presence) return undefined
    return deriveView({ ...profile, id: userId, ...(presence ? { presence } : {}) }, [
      ...(profile && registry ? [collectionEvidence(registry.queryClient, "profiles", [profile.userId], [profile])] : []),
      ...(presence && registry ? [presenceVersion(registry, userId, presence)] : []),
    ])
  }, [userId, preview, profile, presence, registry])
}

export function useAttentionScopes(): readonly AttentionScopeRow[] {
  const { registry, data } = useCollectionQuery("attentionScopes")
  return annotateRows(registry, "attentionScopes", data ?? [])!
}

export function useAttentionItems(): readonly AttentionItemRow[] {
  const { registry, data } = useCollectionQuery("attentionItems")
  return annotateRows(registry, "attentionItems", data ?? [])!
}

export function useChannelRefDirectoryProjection(): ChannelRefDirectory | undefined {
  const rows = { servers: useServerRows(), channels: useChannelRows() }
  return useMemo(() => {
    if (!rows.servers || !rows.channels) return undefined
    const channels = rows.channels
    return rows.servers.map((server) => ({
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      channels: channels
        .filter((channel) => channel.serverId === server.id)
        .flatMap((channel) => (
          channel.type === "text" || channel.type === "forum"
            ? [{ id: channel.id, name: channel.name, type: channel.type }]
            : []
        )),
    }))
  }, [rows.channels, rows.servers])
}

export function useForumSidebarProjection(
  serverId: string,
  retainId: string | null,
  serverNowMs: number | null,
) {
  const registry = useOptionalCommunityDbRegistry()
  const channels = useChannelRows(serverId)
  const channelIds = useMemo(() => (channels ?? []).map((channel) => channel.id), [channels])
  const channelMemberships = useChannelMembershipRows(channelIds)
  const openerIds = useMemo(() => (channels ?? []).flatMap((channel) => (
    channel.parentMessageId ? [channel.parentMessageId] : []
  )), [channels])
  const messages = useMessageRowsById(openerIds)
  const rows = { registry, channels, channelMemberships, messages }
  return useMemo(() => {
    if (
      serverNowMs === null
      || !rows.registry
      || !rows.channels
      || !rows.channelMemberships
      || !rows.messages
    ) return undefined
    const { threads, parentUnread } = projectForumSidebar(rows.channels, rows.channelMemberships, rows.messages,
      rows.registry.accountId, serverId, retainId, serverNowMs)
    deriveView(threads, [viewEvidence(rows.channels), viewEvidence(rows.channelMemberships), viewEvidence(rows.messages)])
    return deriveView({ threads, parentUnread }, [viewEvidence(threads)], threads.length)
  }, [serverNowMs, rows.registry, rows.channels, rows.channelMemberships, rows.messages, serverId, retainId])
}
