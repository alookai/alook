"use client"

import type { CommunityResourceProfile } from "@alook/shared"

import { getServerDirectoryWindow, readServerDirectoryWindow, serverDirectoryWindowComplete } from "@/lib/community/server-directory-window"
import { communityKeys } from "@/lib/query-keys"
import { useQueryClient } from "@tanstack/react-query"
import { forumSidebarWindowComplete, type ForumSidebarWindow } from "@/lib/community/forum-sidebar-window"

import { createContext, createElement, useContext, useEffect, useMemo, useCallback, useSyncExternalStore, type Context, type ReactNode } from "react"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import { DbProvider, and, eq, inArray, isNull, useLiveQuery, type WhereCallback, type ContextFromSource } from "@tanstack/react-db"
import { createStore, useSelector } from "@tanstack/react-store"
import { CommunityRuntimeProvider } from "@/stores/community/runtime"
import { serverRailTopOrder, sortServerRailRows, notifLevelDisplay } from "@alook/shared"
import { projectForumSidebarStructure, applyForumSidebarAttention, projectCommunityAttention, supportsSidebarThreads } from "@/lib/community/forum-sidebar"
import { avatarInitial } from "@/lib/community/avatar"
import { readCommunityProfile } from "@/lib/community/profile-read"
import type { DM } from "@/lib/community/models/people"
import { sortDmsByActivity } from "@/lib/community/dm-order"
import type { CommunityProfile } from "@/lib/community/models/people"
import type { Category, CommunityFolder, Server } from "@/lib/community/models/navigation"
import type { Msg } from "@/lib/community/models/message"
import { presentCanonicalMessage } from "@/lib/community/message-wire"
import type { CommunityMessageResource } from "@alook/shared"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type { CommunityDbRegistry } from "./collections"
import { communityCollectionQuery, communityJoinedMessagesQuery } from "./queries"
import { useCommunityPreviewProfiles } from "@/stores/community/profile-preview"

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

function projectedCanonicalMessage(message: MessageRow, child?: ChannelRow): CommunityMessageResource {
  return {
    ...message,
    ...(child ? {
      thread: {
        id: child.id,
        name: child.name ?? "",
        messageCount: child.messageCount ?? 0,
        lastReplyAt: child.lastMessageAt ?? undefined,
        tags: child.tags,
        firstMessageId: child.firstMessageId,
        ...(message.thread?.id === child.id && message.thread.participants !== undefined
          ? { participants: message.thread.participants }
          : {}),
        participantCount: child.participantCount,
      },
    } : {}),
  }
}

function projectedMessage(message: MessageRow, child?: ChannelRow, reply?: MessageRow): Msg {
  return presentCanonicalMessage(projectedCanonicalMessage(message, child), reply?.channelId === message.channelId ? reply : undefined)
}

let communityDbContext: Context<CommunityDbRegistry | null> | null = null

function getCommunityDbContext() {
  communityDbContext ??= createContext<CommunityDbRegistry | null>(null)
  return communityDbContext
}

export function useOptionalCommunityDbRegistry() {
  return useContext(getCommunityDbContext())
}



const absentPresence = createStore({ presenceByUserId: new Map<string, "online" | "offline">() })

export function CommunityDbProvider({
  registry,
  children,
}: {
  registry: CommunityDbRegistry
  children?: ReactNode
}) {
  const application = useMemo(() => {
    const owner = createApplicationOwner(registry.accountId ?? "__guest__", registry.queryClient, registry.assertOnlineAccount)
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

function useProjectionRecovery(registry: CommunityDbRegistry | null, result: {
  isLoadingError: boolean
  health: ReturnType<typeof useLiveQuery>["health"]
  collection?: { reload: () => Promise<void> }
}) {
  const recover = result.isLoadingError && !!result.health?.sources.length && result.health.sources.every(source => source.status === "ready" && !source.hasErrors)
  useEffect(() => {
    if (recover && registry?.runtime.lifecycle.get().active) void result.collection?.reload().catch(() => undefined)
  }, [recover, registry, result.collection])
}

function useCollectionQuery<N extends CommunityCollectionName>(name: N, where?: CollectionWhere<N>, enabled = true) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery(communityCollectionQuery(registry, name, where, enabled))
  useProjectionRecovery(registry, result)
  return { ...result, registry, isError: result.isLoadingError || result.isCrashed || result.isSyncError, data: result.data as CommunityCollectionRows[N][] | undefined }
}

function useCollectionRows<N extends CommunityCollectionName>(name: N, where?: CollectionWhere<N>) {
  const { data } = useCollectionQuery(name, where)
  return data
}

const EMPTY_ATTENTION_SCOPES: readonly AttentionScopeRow[] = Object.freeze([])

function useStableIds(ids?: readonly string[]): readonly string[] | undefined {
  const key = ids === undefined ? undefined : ids.join("\0")
  return useMemo(() => {
    if (key === undefined) return undefined
    if (key === "") return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const id of key.split("\0")) {
      if (!seen.has(id)) {
        seen.add(id)
        result.push(id)
      }
    }
    return result
  }, [key])
}

function useServerRows(serverId?: string) {
  return useCollectionRows("servers", ({ row }) => serverId === undefined ? eq(1, 1) : eq(row.id, serverId))
}
function useViewerServerMembershipRows(viewerId: string | null | undefined) {
  return useCollectionQuery(
    "serverMemberships",
    ({ row }) => and(eq(row.viewer, true), eq(row.userId, viewerId ?? "")),
    !!viewerId,
  ).data
}
function useFolderRows() { return useCollectionRows("folders") }
function useFolderItemRows() { return useCollectionRows("folderItems") }
function useNotificationSettingRows() { return useCollectionRows("notificationSettings") }
function useChannelRows(serverId?: string, type?: ChannelRow["type"]) {
  return useCollectionRows("channels", ({ row }) => and(
    serverId === undefined ? eq(1, 1) : eq(row.serverId, serverId),
    type === undefined ? eq(1, 1) : eq(row.type, type),
  ))
}
function useChannelMembershipRows(channelIds?: readonly string[]) {
  const stableIds = useStableIds(channelIds)
  return useCollectionRows("channelMemberships", ({ row }) => stableIds === undefined ? eq(1, 1) : inArray(row.channelId, [...stableIds]))
}

export function useServerRailStructure() {
  const registry = useOptionalCommunityDbRegistry()
  const servers = useServerRows()
  const serverMemberships = useViewerServerMembershipRows(registry?.accountId)
  const serverRail = useCollectionRows("serverRail")
  const folders = useFolderRows()
  const folderItems = useFolderItemRows()
  const viewerId = registry?.accountId
  const allowedServerIdsKey = serverMemberships === undefined
    ? undefined
    : serverMemberships
      .filter((membership) => membership.viewer && membership.userId === viewerId)
      .map((membership) => membership.serverId)
      .sort()
      .join("\0")
  return useMemo(() => {
    if (!registry || !servers || allowedServerIdsKey === undefined) return undefined
    const allowed = new Set(allowedServerIdsKey === "" ? [] : allowedServerIdsKey.split("\0"))
    const sortedServers: Server[] = servers
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
        unread: false,
        mentions: 0,
        official: server.official,
        isOwner: server.isOwner,
        icon: server.icon,
      }))
    const byServer = new Map(sortedServers.map((server) => [server.id, server]))
    const itemsByFolder = new Map<string, FolderItemRow[]>()
    for (const item of folderItems ?? []) {
      const items = itemsByFolder.get(item.folderId) ?? []
      items.push(item)
      itemsByFolder.set(item.folderId, items)
    }
    const projectedFolders: CommunityFolder[] = (folders ?? [])
      .map((folder) => ({
        id: folder.id,
        name: folder.name,
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
    const state = {
      serverIds: sortedServers.map((server) => server.id),
      folderIds: projectedFolders.map((folder) => folder.id),
      folders: Object.fromEntries(projectedFolders.map((folder) => [folder.id, { id: folder.id, name: folder.name, serverIds: folder.servers.map((server) => server.id) }])),
      topOrder: serverRail?.find((row) => row.id === "account")?.entries,
    }
    const topOrder = serverRailTopOrder(state)
    const byFolder = new Map(projectedFolders.map((folder) => [folder.id, folder]))
    return { servers: sortServerRailRows(state, sortedServers), folders: topOrder.flatMap((entry) => entry.kind === "folder" ? [byFolder.get(entry.id)!] : []), topOrder }
  }, [registry, servers, allowedServerIdsKey, folders, folderItems, serverRail])
}

export function useServerRailProjection() {
  const structure = useServerRailStructure()
  const attention = useAttentionScopes()
  return useMemo(() => {
    if (!structure) return undefined
    const projected = projectCommunityAttention(attention)
    const servers = structure.servers.map(server => {
      const summary = projected.servers.get(server.id)
      const unread = summary?.unread ?? false, mentions = summary?.mentions ?? 0
      return unread === server.unread && mentions === server.mentions ? server : { ...server, unread, mentions }
    })
    return servers.every((server, index) => server === structure.servers[index]) ? structure : { ...structure, servers }
  }, [structure, attention])
}

export function useServerTreeProjection(serverId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const queryClient = useQueryClient()
  const read = useCallback(() => queryClient.getQueryData(communityKeys.server(serverId ?? "__none__")), [queryClient, serverId])
  const subscribe = useCallback((notify: () => void) => queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey
    if (key.length === 3 && key[0] === "community" && key[1] === "servers" && key[2] === (serverId ?? "__none__")) notify()
  }), [queryClient, serverId])
  const snapshot = useSyncExternalStore(subscribe, read, read)
  const directory = useMemo(() => readServerDirectoryWindow(snapshot), [snapshot])
  const servers = useCollectionQuery("servers", ({ row }) => eq(row.id, serverId ?? ""))
  const categories = useCollectionQuery("categories", ({ row }) => eq(row.serverId, serverId ?? ""))
  const channels = useCollectionQuery("channels", ({ row }) => eq(row.serverId, serverId ?? ""))
  const attention = useServerAttentionScopes(serverId)
  const ready = servers.isReady && categories.isReady && channels.isReady
  const rows = { servers: servers.data, categories: categories.data, channels: channels.data }
  const structure = useMemo(() => {
    if (!ready || !serverId || !rows.servers || !rows.categories || !rows.channels) return undefined
    const server = rows.servers.find((candidate) => candidate.id === serverId)
    if (!server || !registry || !directory || !serverDirectoryWindowComplete(directory, { servers: [registry.collections.servers.base.get(serverId)].filter(row => row !== undefined), categories: directory.categoryIds.flatMap(id => { const row = registry.collections.categories.base.get(id); return row ? [row] : [] }), channels: directory.channelIds.flatMap(id => { const row = registry.collections.channels.base.get(id); return row ? [row] : [] }) }, registry.accountId, serverId)) return undefined
    const channelIds = new Set(directory.channelIds), categoryIds = new Set(directory.categoryIds)
    const channels = rows.channels.filter((channel) => (
      channel.serverId === serverId && channel.type !== "thread" && (channelIds.has(channel.id) || channel.pending)
    ))
    const channelView = (channel: ChannelRow): Category["channels"][number] => ({
      id: channel.id,
      name: channel.name ?? "",
      active: false,
      unread: false,
      muted: channel.muted,
      type: channel.type === "forum" ? "forum" : "text",
      tags: channel.tags,
      creatorId: channel.creatorId,
      pending: channel.pending,
    })
    const byCategory = new Map<string | null, ChannelRow[]>()
    for (const channel of channels) {
      const bucket = byCategory.get(channel.categoryId) ?? []
      bucket.push(channel)
      byCategory.set(channel.categoryId, bucket)
    }
    const categories: Category[] = rows.categories
      .filter((category) => category.serverId === serverId && (categoryIds.has(category.id) || category.pending))
      .sort((a, b) => a.position - b.position)
      .map((category) => ({
        id: category.id,
        name: category.name,
        private: category.private,
        creatorId: category.creatorId,
        pending: category.pending,
        channels: (byCategory.get(category.id) ?? [])
          .sort((a, b) => a.position - b.position)
          .map(channelView),
      }))
    const uncategorized = (byCategory.get(null) ?? [])
      .sort((a, b) => a.position - b.position)
      .map(channelView)
    if (uncategorized.length > 0) {
      categories.push({ id: "__uncategorized__", name: "", private: false, channels: uncategorized })
    }
    const view = {
      id: server.id, name: server.name, discriminator: server.discriminator,
      description: server.description, icon: server.icon, official: server.official,
      ownerId: server.ownerId, categories,
    }
    return view
  }, [ready, rows.servers, rows.categories, rows.channels, serverId, directory, registry])
  return useMemo(() => {
    if (!structure || !serverId) return undefined
    const unread = projectCommunityAttention(attention).channels.get(serverId)
    const categories = structure.categories.map(category => {
      const channels = category.channels.map(channel => {
        const value = unread?.has(channel.id) ?? false
        return channel.unread === value ? channel : { ...channel, unread: value }
      })
      return channels.every((channel, index) => channel === category.channels[index]) ? category : { ...category, channels }
    })
    return categories.every((category, index) => category === structure.categories[index]) ? structure : { ...structure, categories }
  }, [structure, attention, serverId])
}

export function useDmProjection(options?: { includePresence?: boolean }) {
  const includePresence = options?.includePresence ?? true
  const registry = useOptionalCommunityDbRegistry()
  const previewProfiles = useCommunityPreviewProfiles()
  const channels = useChannelRows(undefined, "dm")
  const channelIds = useMemo(() => (channels ?? []).map((channel) => channel.id), [channels])
  const channelMemberships = useChannelMembershipRows(channelIds)
  const peerUserIds = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const membership of channelMemberships ?? []) {
      if (membership.relation === "access" && membership.userId !== registry?.accountId && !seen.has(membership.userId)) {
        seen.add(membership.userId)
        result.push(membership.userId)
      }
    }
    return result
  }, [channelMemberships, registry?.accountId])
  const stablePeerUserIds = useStableIds(peerUserIds) ?? []
  const profiles = useCollectionQuery("profiles", ({ row }) => inArray(row.id, [...stablePeerUserIds])).data
  const livePresence = useSelector(
    registry?.runtime.ws ?? absentPresence,
    (state) => !includePresence || previewProfiles
      ? null
      : stablePeerUserIds.map((id) => [id, state.presenceByUserId.get(id)] as const),
    {
      compare: (left, right) =>
        left === right || (!!left && !!right && left.length === right.length
          && left.every(([id, presence], index) => id === right[index]?.[0] && presence === right[index]?.[1])),
    },
  )
  const attention = useDmAttentionScopes()
  return useMemo(() => {
    const viewerId = registry?.accountId
    if (!viewerId || !channels || !channelMemberships || (!profiles && !previewProfiles)) return undefined
    const peerByChannelId = new Map<string, string>()
    for (const membership of channelMemberships) {
      if (membership.relation === "access" && membership.userId !== viewerId && !peerByChannelId.has(membership.channelId)) {
        peerByChannelId.set(membership.channelId, membership.userId)
      }
    }
    const attentionByChannelId = new Map<string, AttentionScopeRow>()
    for (const scope of attention) {
      if (!attentionByChannelId.has(scope.channelId)) attentionByChannelId.set(scope.channelId, scope)
    }
    const profileById = new Map<string, CommunityProfile>(
      previewProfiles
        ? [...previewProfiles.entries()]
        : (profiles ?? []).map((profile) => [profile.id, { ...profile, id: profile.id }]),
    )
    if (!previewProfiles && livePresence) {
      for (const [userId, presence] of livePresence) {
        if (presence === undefined) continue
        const prior = profileById.get(userId)
        if (prior) profileById.set(userId, { ...prior, presence })
      }
    }
    return sortDmsByActivity(channels
      .filter((channel) => channel.type === "dm")
      .flatMap((channel): DM[] => {
        const peerUserId = peerByChannelId.get(channel.id)
        if (!peerUserId) return []
        const rawProfile = profileById.get(peerUserId)
        if (!rawProfile) return []
        const profile = readCommunityProfile(rawProfile, peerUserId)
        const scope = attentionByChannelId.get(channel.id)
        return [{
          ...profile,
          id: channel.id,
          userId: peerUserId,
          status: profile.presence,
          preview: channel.preview ?? "",
          ...(channel.lastMessageAt ? { activityAt: channel.lastMessageAt } : {}),
          unread: scope?.ordinaryUnread ?? false,
          ...(scope ? { lastUnreadSeq: scope.lastUnreadSeq } : {}),
        }]
      }))
  }, [attention, registry, channels, channelMemberships, profiles, previewProfiles, livePresence])
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
  const result = useLiveQuery(communityJoinedMessagesQuery(registry, channelId, ids))
  useProjectionRecovery(registry, result)
  return { registry, data: result.data as Array<{ message: MessageRow; child?: ChannelRow; reply?: MessageRow }> | undefined, status: result.status }
}

export function useCanonicalMessagesById(ids?: readonly string[]): ReadonlyMap<string, Msg> | undefined {
  const { registry, data } = useJoinedMessageQuery(undefined, ids)
  return useMemo(() => !registry ? undefined : new Map(
    (data ?? []).map(({ message, child, reply }) => {
      return [message.id, projectedMessage(message, child, reply)]
    }),
  ), [registry, data])
}

export function useMessageWindowProjection(channelId: string | null, ids: readonly string[], liveIds: readonly string[]) {
  const allIds = useMemo(() => [...new Set([...ids, ...liveIds])], [ids, liveIds])
  const { data, status } = useJoinedMessageQuery(channelId, allIds)
  const canonicalMessages = useMemo(() => !channelId || !data ? undefined : data
    .sort((a, b) => (a.message.seq ?? 0) - (b.message.seq ?? 0))
    .map(({ message, child }) => projectedCanonicalMessage(message, child)), [channelId, data])
  const relatedMessages = useMemo(() => data?.flatMap(({ message, reply }) => reply?.channelId === message.channelId ? [reply] : []) ?? [], [data])
  return { canonicalMessages, relatedMessages, windowIds: ids, status }
}

function useCollectionById<N extends "categories" | "channels" | "servers">(name: N) {
  const rows = useCollectionRows(name)
  return useMemo(() => new Map((rows ?? []).map((row) => [row.id, row])), [rows])
}

export function useCanonicalChannelsById(): ReadonlyMap<string, ChannelRow> { return useCollectionById("channels") }

export function useChildChannelsByParentId(parentChannelId: string | null | undefined, enabled = true): ReadonlyMap<string, ChannelRow> {
  const { data } = useCollectionQuery("channels", ({ row }) => eq(row.parentChannelId, parentChannelId ?? ""), enabled && !!parentChannelId)
  return useMemo(() => new Map((data ?? []).map((row) => [row.id, row])), [data])
}

export function useChannelsByIds(channelIds: readonly string[], enabled = true): ReadonlyMap<string, ChannelRow> {
  const stableIds = useStableIds(channelIds) ?? []
  const { data } = useCollectionQuery("channels", ({ row }) => inArray(row.id, [...stableIds]), enabled && stableIds.length > 0)
  return useMemo(() => new Map((data ?? []).map((row) => [row.id, row])), [data])
}

export function useCanonicalCategoriesById() { return useCollectionById("categories") }

export function useFriendshipProjection(ids?: readonly string[]) {
  return useCollectionQuery("friendships", ({ row }) => ids === undefined ? eq(1, 1) : inArray(row.id, [...ids]))
}

export function useFriendshipRows(ids?: readonly string[]) {
  return useFriendshipProjection(ids).data ?? []
}

export function useCanonicalServersById(): ReadonlyMap<string, ServerRow> { return useCollectionById("servers") }

export function useCanonicalCommunityServer(serverId: string | null | undefined) {
  return useServerRows(serverId ?? "__inactive__")?.[0]
}

export function materializeCanonicalMessage(
  transport: Pick<Msg, "id">,
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg | undefined {
  return canonical?.get(transport.id)
}

export function materializeCanonicalMessages(
  transport: readonly Pick<Msg, "id">[],
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg[] {
  return transport.flatMap((message) => {
    const row = canonical?.get(message.id)
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

export function useCanonicalIdentitiesProjection(userIds?: readonly string[], enabled = true) {
  const previewProfiles = useCommunityPreviewProfiles()
  const stableIds = useStableIds(userIds)
  const projection = useCollectionQuery(
    "profiles",
    ({ row }) => stableIds === undefined ? eq(1, 1) : inArray(row.id, [...stableIds]),
    enabled,
  )
  const resourceProfiles: ReadonlyMap<string, CommunityResourceProfile> = useMemo(
    () => new Map((projection.data ?? []).map(profile => [profile.id, profile])),
    [projection.data],
  )
  const data: ReadonlyMap<string, CommunityProfile> = useMemo(() => {
    if (previewProfiles) return previewProfiles
    return resourceProfiles
  }, [previewProfiles, resourceProfiles])
  return { ...projection, data, resourceProfiles, isReady: !!previewProfiles || projection.isReady, isError: !previewProfiles && projection.isError, isEnabled: !!previewProfiles || projection.isEnabled }
}

export function useCanonicalIdentitiesByUserId(userIds?: readonly string[], enabled = true): ReadonlyMap<string, CommunityProfile> {
  return useCanonicalIdentitiesProjection(userIds, enabled).data
}

export function useCanonicalCommunityIdentity(userId: string | null | undefined): CommunityProfile | undefined {
  const preview = useCommunityPreviewProfiles()
  const { data } = useCollectionQuery("profiles", ({ row }) => eq(row.id, userId ?? ""), !!userId)
  const profile = data?.[0]
  return useMemo(() => {
    if (!userId) return undefined
    if (preview) return preview.get(userId)
    return profile
  }, [userId, preview, profile])
}

export function useCanonicalProfileLookup(): (userId: string) => boolean {
  const registry = useOptionalCommunityDbRegistry()
  const preview = useCommunityPreviewProfiles()
  return useCallback(
    (userId: string) => preview ? preview.has(userId) : registry?.collections.profiles.has(userId) ?? false,
    [preview, registry],
  )
}

export function useCanonicalProfilesProjection(userIds?: readonly string[], enabled = true) {
  const previewProfiles = useCommunityPreviewProfiles()
  const stableIds = useStableIds(userIds)
  const active = enabled && (stableIds === undefined || stableIds.length > 0)
  const projection = useCollectionQuery(
    "profiles",
    ({ row }) => stableIds === undefined ? eq(1, 1) : inArray(row.id, [...stableIds]),
    active,
  )
  const { registry } = projection
  const resourceProfiles: ReadonlyMap<string, CommunityResourceProfile> = useMemo(() => new Map((projection.data ?? []).map(profile => [profile.id, profile])), [projection.data])
  const livePresence = useSelector(active ? (registry?.runtime.ws ?? absentPresence) : absentPresence, (state) => !active || previewProfiles ? null : stableIds === undefined ? [...state.presenceByUserId] : stableIds.map((id) => [id, state.presenceByUserId.get(id)] as const), { compare: (left, right) => left === right || (!!left && !!right && left.length === right.length && left.every(([id, presence], index) => id === right[index]?.[0] && presence === right[index]?.[1])) })
  const data: ReadonlyMap<string, CommunityProfile> = useMemo(() => {
    if (previewProfiles) return previewProfiles
    if (!active) return new Map<string, CommunityProfile>()
    const merged = new Map<string, CommunityProfile>()
    for (const profile of projection.data ?? []) {
      merged.set(profile.id, { ...profile, id: profile.id })
    }
    for (const [userId, presence] of livePresence ?? []) {
      if (presence === undefined) continue
      const prior = merged.get(userId)
      const value = { ...prior, id: userId, presence }
      merged.set(userId, value)
    }
    return merged
  }, [active, projection.data, livePresence, previewProfiles])
  return { ...projection, data, resourceProfiles, isReady: !!previewProfiles || !active || projection.isReady, isError: !previewProfiles && active && projection.isError, isEnabled: !!previewProfiles || (!active && enabled) || projection.isEnabled }
}

export function useCanonicalProfilesByUserId(userIds?: readonly string[], enabled = true): ReadonlyMap<string, CommunityProfile> {
  return useCanonicalProfilesProjection(userIds, enabled).data
}

export function getMemberReadState(
  enabled: boolean,
  transport: { pending: boolean; failed: boolean },
  projections: readonly { isReady: boolean; isError: boolean; isEnabled: boolean }[],
  userIds: readonly string[],
  profiles: ReadonlyMap<string, CommunityResourceProfile>,
) {
  if (!enabled) return { loading: false, failed: false }
  const failed = transport.failed || projections.some((projection) => projection.isError)
  const loading = !failed && (transport.pending || projections.some((projection) => !projection.isEnabled || !projection.isReady))
  const missingProfile = !loading && userIds.some((id) => !profiles.has(id))
  return { loading, failed: failed || missingProfile }
}

export function useServerMemberProjection(serverId: string | null, userIds: readonly string[]) {
  const stableIds = useStableIds(userIds) ?? []
  return useCollectionQuery("serverMemberships", ({ row }) => and(eq(row.serverId, serverId), inArray(row.userId, [...stableIds])), !!serverId)
}

export function useServerMemberRows(serverId: string | null, userIds: readonly string[]) {
  const { data } = useServerMemberProjection(serverId, userIds)
  return data ?? []
}

export function useChannelRosterProjection(channelId: string, relation: "access" | "notify") {
  return useCollectionQuery("channelMemberships", ({ row }) => and(eq(row.channelId, channelId), eq(row.relation, relation)), !!channelId)
}

export function useChannelRosterRows(channelId: string, relation: "access" | "notify") {
  const { data } = useChannelRosterProjection(channelId, relation)
  return data ?? []
}

export function useCanonicalCommunityProfile(userId: string | null | undefined) {
  const preview = useCommunityPreviewProfiles()
  const { registry, data } = useCollectionQuery("profiles", ({ row }) => eq(row.id, userId), !!userId)
  const profile = data?.[0]
  const presence = useSelector(registry?.runtime.ws ?? absentPresence, (state) => userId ? state.presenceByUserId.get(userId) : undefined)
  return useMemo(() => {
    if (!userId) return undefined
    if (preview) return preview.get(userId)
    if (!profile && !presence) return undefined
    return { ...profile, id: userId, ...(presence ? { presence } : {}) }
  }, [userId, preview, profile, presence])
}

export function useAttentionScopes(): readonly AttentionScopeRow[] {
  const { data } = useCollectionQuery("attentionScopes")
  return data ?? EMPTY_ATTENTION_SCOPES
}

export function useServerAttentionScopes(serverId: string | null, enabled = true): readonly AttentionScopeRow[] {
  const { data } = useCollectionQuery("attentionScopes", ({ row }) => eq(row.serverId, serverId ?? ""), enabled && !!serverId)
  return data ?? EMPTY_ATTENTION_SCOPES
}

export function useDmAttentionScopes(enabled = true): readonly AttentionScopeRow[] {
  const { data } = useCollectionQuery("attentionScopes", ({ row }) => isNull(row.serverId), enabled)
  return data ?? EMPTY_ATTENTION_SCOPES
}

export function useAttentionItems(): readonly AttentionItemRow[] {
  const { data } = useCollectionQuery("attentionItems")
  return data ?? []
}

export function useChannelRefDirectoryProjection(): ChannelRefDirectory | undefined {
  const rows = { servers: useServerRows(), channels: useChannelRows() }
  return useMemo(() => {
    if (!rows.servers || !rows.channels) return undefined
    const channelsByServer = new Map<string, Array<{ id: string; name: string; type: "text" | "forum" }>>()
    for (const channel of rows.channels) {
      if (!channel.serverId || (channel.type !== "text" && channel.type !== "forum")) continue
      let list = channelsByServer.get(channel.serverId)
      if (!list) { list = []; channelsByServer.set(channel.serverId, list) }
      list.push({ id: channel.id, name: channel.name ?? "", type: channel.type })
    }
    return rows.servers.map((server) => ({
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      channels: channelsByServer.get(server.id) ?? [],
    }))
  }, [rows.channels, rows.servers])
}

function useForumSidebarRows(serverId: string) {
  const serverProjection = useCollectionQuery("servers", ({ row }) => eq(row.id, serverId))
  const channelProjection = useCollectionQuery("channels", ({ row }) => eq(row.serverId, serverId))
  const channels = channelProjection.data
  const channelIds = useMemo(() => (channels ?? []).map(row => row.id), [channels])
  const membershipProjection = useCollectionQuery("channelMemberships", ({ row }) => inArray(row.channelId, channelIds))
  const openerIds = useMemo(() => (channels ?? []).flatMap(row => row.parentMessageId ? [row.parentMessageId] : []), [channels])
  const messageProjection = useCollectionQuery("messages", ({ row }) => inArray(row.id, openerIds))
  const ready = serverProjection.isReady && channelProjection.isReady && membershipProjection.isReady && messageProjection.isReady
  return { registry: channelProjection.registry, ready, servers: serverProjection.data, channels,
    channelMemberships: membershipProjection.data, messages: messageProjection.data, attention: useServerAttentionScopes(serverId) }
}

export function useServerSidebarProjection(
  serverId: string, retainId: string | null, serverNowMs: number | null, window: ForumSidebarWindow | undefined, failed: boolean,
) {
  const server = useServerTreeProjection(serverId)
  const { ready, registry, servers, channels, channelMemberships, messages, attention } = useForumSidebarRows(serverId)
  const structure = useMemo(() => {
    if (serverNowMs === null || !ready || !registry || !servers || !channels || !channelMemberships || !messages) return undefined
    return projectForumSidebarStructure(channels, channelMemberships, messages, registry.accountId, serverId, retainId, serverNowMs)
  }, [serverNowMs, ready, registry, servers, channels, channelMemberships, messages, serverId, retainId])
  const hasServer = !!server
  const complete = useMemo(() => !!structure && hasServer && !!registry && !!channels && !!servers && !!channelMemberships && !!messages && serverNowMs !== null
    && (!channels.some(row => supportsSidebarThreads(row.type)) || !!window && forumSidebarWindowComplete(window,
      { directory: getServerDirectoryWindow(registry, serverId), servers, channels, channelMemberships, messages }, registry.accountId, serverId, retainId, serverNowMs, structure.threads)),
  [structure, hasServer, registry, channels, servers, channelMemberships, messages, window, serverId, retainId, serverNowMs])
  const projection = useMemo(() => structure && applyForumSidebarAttention(structure, serverId, attention), [structure, serverId, attention])
  return { server, projection, status: complete ? "ready" as const : failed ? "error" as const : "pending" as const,
    needsRead: !!structure && hasServer && !!window && !complete }
}

export function useChannelReadStateProjection(channelId: string | null) {
  const read = useCollectionQuery("readStates", ({ row }) => eq(row.channelId, channelId ?? ""), !!channelId)
  const clock = useCollectionRows("readStateClock")
  return { readState: read.data?.[0], hasSnapshot: (clock?.[0]?.revision ?? -1) >= 0 }
}
