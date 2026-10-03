"use client"

import { createContext, createElement, useContext, useMemo, useLayoutEffect, type Context, type ReactNode } from "react"
import { ApplicationOwnerProvider, createApplicationOwner } from "@/lib/application-owner"
import { DbProvider, collectionOptions, getLiveQueryHash, liveQueryCollectionOptions, prepareLiveQueryValue, eq, inArray, useLiveQuery as useNativeLiveQuery, type Context as QueryContext, type LiveQueryCollectionConfig } from "@tanstack/react-db"
import { createStore, useSelector } from "@tanstack/react-store"
import { CommunityRuntimeProvider } from "@/stores/community/runtime"
import { notifLevelDisplay } from "@alook/shared"
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

import type {
  AttentionItemRow,
  AttentionScopeRow,
  CategoryRow,
  ChannelMembershipRow,
  ChannelRow,
  FolderItemRow,
  FolderRow,
  MessageRow,
  FriendshipRow,
  NotificationSettingRow,
  ProfileRow,
  ReadStateRow,
  ServerMembershipRow,
  ServerRow,
} from "./schema"

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
  useLayoutEffect(() => {
    const subscription = registry.runtime.lifecycle.subscribe(() => {
      if (!registry.runtime.lifecycle.get().active) application.preferences.setState((state) => ({ ...state, localValues: new Map() }))
    })
    return () => subscription.unsubscribe()
  }, [application, registry])
  return createElement(
    ApplicationOwnerProvider, { owner: application },
    createElement(DbProvider, { client: registry.dbClient },
      createElement(getCommunityDbContext().Provider, { value: registry },
        createElement(CommunityRuntimeProvider, { value: { runtime: registry.runtime } }, children))),
  )
}

function useServerRows(serverId?: string) {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ server: registry.collections.servers }).where(({ server }) => serverId === undefined ? eq(1, 1) : eq(server.id, serverId))
      : undefined,
  }).data as ServerRow[] | undefined
}

function useCategoryRows(serverId?: string) {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ category: registry.collections.categories }).where(({ category }) => serverId === undefined ? eq(1, 1) : eq(category.serverId, serverId))
      : undefined,
  }).data as CategoryRow[] | undefined
}

function useServerMembershipRows() {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ membership: registry.collections.serverMemberships })
      : undefined,
  }).data as ServerMembershipRow[] | undefined
}

function useFolderRows() {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ folder: registry.collections.folders })
      : undefined,
  }).data as FolderRow[] | undefined
}

function useFolderItemRows() {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ item: registry.collections.folderItems })
      : undefined,
  }).data as FolderItemRow[] | undefined
}

function useNotificationSettingRows() {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ setting: registry.collections.notificationSettings })
      : undefined,
  }).data as NotificationSettingRow[] | undefined
}

function useChannelRows(serverId?: string, type?: ChannelRow["type"]) {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => {
      if (!registry) return undefined
      let query = q.from({ channel: registry.collections.channels })
      if (serverId !== undefined) query = query.where(({ channel }) => eq(channel.serverId, serverId))
      if (type !== undefined) query = query.where(({ channel }) => eq(channel.type, type))
      return query
    },
  }).data as ChannelRow[] | undefined
}

function useChannelMembershipRows(channelIds?: string[]) {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ membership: registry.collections.channelMemberships })
        .where(({ membership }) => channelIds === undefined ? eq(1, 1) : inArray(membership.channelId, channelIds))
      : undefined,
  }).data as ChannelMembershipRow[] | undefined
}

function useMessageRowsById(messageIds: string[]) {
  const registry = useOptionalCommunityDbRegistry()
  return useLiveQuery({
    query: (q) => registry
      ? q.from({ message: registry.collections.messages }).where(({ message }) => inArray(message.id, messageIds))
      : undefined,
  }).data as MessageRow[] | undefined
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
    return { servers, folders }
  }, [rows.registry, rows.servers, rows.serverMemberships, rows.folders, rows.folderItems])
}

export function useServerTreeProjection(serverId: string | null) {
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
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            active: false,
            unread: channel.unread,
            muted: channel.muted,
            type: channel.type === "forum" ? "forum" : "text",
            tags: channel.tags,
            creatorId: channel.creatorId,
            pending: channel.pending,
          })),
      }))
    const uncategorized = channels
      .filter((channel) => !channel.categoryId)
      .sort((a, b) => a.position - b.position)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        active: false,
        unread: channel.unread,
        muted: channel.muted,
        type: channel.type === "forum" ? "forum" as const : "text" as const,
        tags: channel.tags,
        creatorId: channel.creatorId,
        pending: channel.pending,
      }))
    if (uncategorized.length > 0) {
      categories.push({ id: "__uncategorized__", name: "", private: false, channels: uncategorized })
    }
    return {
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      description: server.description,
      icon: server.icon,
      official: server.official,
      ownerId: server.ownerId,
      categories,
    }
  }, [rows.servers, rows.categories, rows.channels, serverId])
}

export function useDmProjection() {
  const registry = useOptionalCommunityDbRegistry()
  const channels = useChannelRows(undefined, "dm")
  const channelIds = useMemo(() => (channels ?? []).map((channel) => channel.id), [channels])
  const channelMemberships = useChannelMembershipRows(channelIds)
  const userIds = useMemo(() => (channelMemberships ?? []).filter((membership) => (
    membership.relation === "access" && membership.userId !== registry?.accountId
  )).map((membership) => membership.userId), [channelMemberships, registry?.accountId])
  const profiles = useLiveQuery({
    query: (q) => registry
      ? q.from({ profile: registry.collections.profiles }).where(({ profile }) => inArray(profile.userId, userIds))
      : undefined,
  }).data as ProfileRow[] | undefined
  const readStates = useLiveQuery({
    query: (q) => registry
      ? q.from({ readState: registry.collections.readStates }).where(({ readState }) => inArray(readState.channelId, channelIds))
      : undefined,
  }).data as ReadStateRow[] | undefined
  const rows = { registry, channels, channelMemberships, profiles, readStates }
  return useMemo(() => {
    const viewerId = rows.registry?.accountId
    if (!viewerId || !rows.channels || !rows.channelMemberships || !rows.profiles) return undefined
    const channelMemberships = rows.channelMemberships
    const profileById = new Map(rows.profiles.map((profile) => [profile.userId, profile]))
    const readStateByChannel = new Map((rows.readStates ?? []).map((state) => [state.channelId, state]))
    return sortDmsByActivity(rows.channels
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
  }, [rows.registry?.accountId, rows.channels, rows.channelMemberships, rows.profiles, rows.readStates])
}

export function useRouteChannelProjection(channelId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ channel: registry.collections.channels }).where(({ channel }) => eq(channel.id, channelId ?? ""))
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return (result.data as ChannelRow[]).find((row) => row.id === channelId)
  }, [channelId, result.data])
}

export function useReadStateProjection(channelId: string | null | undefined) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ readState: registry.collections.readStates }).where(({ readState }) => eq(readState.channelId, channelId ?? ""))
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    const row = (result.data as ReadStateRow[])
      .find((candidate) => candidate.channelId === channelId)
    if (!row) return undefined
    return {
      lastReadMessageId: row.lastReadMessageId,
      lastReadAt: row.lastReadAt,
      lastReadSeq: row.lastReadSeq,
    }
  }, [channelId, result.data])
}

export function useMessageProjection(channelId: string | null, ids?: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry && channelId
      ? q.from({ message: registry.collections.messages }).where(({ message }) => eq(message.channelId, channelId))
        .where(({ message }) => ids === undefined ? eq(1, 1) : inArray(message.id, [...ids]))
        .leftJoin({ child: registry.collections.channels }, ({ message, child }) => eq(message.id, child.parentMessageId))
        .select(({ message, child }) => ({ message, child }))
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return (result.data as Array<{ message: MessageRow; child?: ChannelRow }>)
      .sort((a, b) => (a.message.seq ?? 0) - (b.message.seq ?? 0))
      .map(({ message, child }) => {
        const { channelId: _channelId, replyToId: _replyToId, ...model } = message
        return { ...model, ...(child ? { thread: { id: child.id, name: child.name, messageCount: child.messageCount ?? 0, lastReplyAt: child.lastMessageAt ?? undefined, tags: child.tags, preview: child.preview, participantCount: child.participantCount } } : {}) } as Msg
      })
  }, [channelId, result.data])
}

export function useCanonicalMessagesById(ids?: readonly string[]): ReadonlyMap<string, Msg> | undefined {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ message: registry.collections.messages })
        .where(({ message }) => ids === undefined ? eq(1, 1) : inArray(message.id, [...ids]))
        .leftJoin({ child: registry.collections.channels }, ({ message, child }) => eq(message.id, child.parentMessageId))
        .select(({ message, child }) => ({ message, child }))
      : undefined,
  })
  return useMemo(() => !registry ? undefined : new Map(
    ((result.data ?? []) as Array<{ message: MessageRow; child?: ChannelRow }>).map(({ message, child }) => {
      const { channelId: _channelId, replyToId: _replyToId, ...model } = message
      return [message.id, { ...model, ...(child ? { thread: { id: child.id, name: child.name, messageCount: child.messageCount ?? 0, lastReplyAt: child.lastMessageAt ?? undefined, tags: child.tags, preview: child.preview, participantCount: child.participantCount } } : {}) } as Msg]
    }),
  ), [registry, result.data])
}

export function useMessageWindowProjection(channelId: string | null, ids?: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  const warm = useLiveQuery({ query: (q) => registry && channelId && ids === undefined
    ? q.from({ message: registry.collections.messages }).where(({ message }) => eq(message.channelId, channelId))
      .orderBy(({ message }) => message.seq, "desc").orderBy(({ message }) => message.id, "desc")
      .limit(MAX_PERSISTED_MESSAGES_PER_SCOPE).select(({ message }) => ({ id: message.id }))
    : undefined }).data as Array<{ id: string }> | undefined
  const selected = useMemo(() => ids ?? warm?.map((message) => message.id) ?? [], [ids, warm])
  return useMessageProjection(channelId, selected)
}

export function useCanonicalChannelsById(): ReadonlyMap<string, ChannelRow> {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ channel: registry.collections.channels })
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ChannelRow[]).map((channel) => [channel.id, channel]),
  ), [result.data])
}

export function useFriendshipRows(ids?: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  return (useLiveQuery({ query: (q) => registry ? q.from({ friendship: registry.collections.friendships }).where(({ friendship }) => ids === undefined ? eq(1, 1) : inArray(friendship.id, [...ids])) : undefined }).data ?? []) as FriendshipRow[]
}

export function useCanonicalServersById(): ReadonlyMap<string, ServerRow> {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ server: registry.collections.servers })
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ServerRow[]).map((server) => [server.id, server]),
  ), [result.data])
}

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
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ profile: registry.collections.profiles }).where(({ profile }) => userIds === undefined ? eq(1, 1) : inArray(profile.userId, [...userIds]))
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ProfileRow[]).map((profile) => [profile.userId, profile]),
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
      merged.set(userId, { ...profile, id: userId })
    }
    for (const [userId, presence] of livePresence ?? []) {
      if (presence === undefined) continue
      merged.set(userId, { ...merged.get(userId), id: userId, presence })
    }
    return merged
  }, [canonicalProfiles, livePresence, previewProfiles])
}

export function useServerMemberRows(serverId: string | null, userIds: readonly string[]) {
  const registry = useOptionalCommunityDbRegistry()
  return (useLiveQuery({ query: (q) => registry && serverId ? q.from({ membership: registry.collections.serverMemberships }).where(({ membership }) => eq(membership.serverId, serverId)).where(({ membership }) => inArray(membership.userId, [...userIds])) : undefined }).data ?? []) as ServerMembershipRow[]
}

export function useChannelRosterRows(channelId: string, relation: "access" | "notify") {
  const registry = useOptionalCommunityDbRegistry()
  return (useLiveQuery({ query: (q) => registry && channelId ? q.from({ membership: registry.collections.channelMemberships }).where(({ membership }) => eq(membership.channelId, channelId)).where(({ membership }) => eq(membership.relation, relation)) : undefined }).data ?? []) as ChannelMembershipRow[]
}

export function useCanonicalCommunityProfile(userId: string | null | undefined) {
  const registry = useOptionalCommunityDbRegistry()
  const preview = useCommunityPreviewProfiles()
  const profile = useLiveQuery({ query: (q) => registry && userId ? q.from({ profile: registry.collections.profiles }).where(({ profile }) => eq(profile.userId, userId)) : undefined }).data?.[0] as ProfileRow | undefined
  const presence = useSelector(registry?.runtime.ws ?? absentPresence, (state) => userId ? state.presenceByUserId.get(userId) : undefined)
  return useMemo(() => {
    if (!userId) return undefined
    if (preview) return preview.get(userId)
    return profile || presence ? { ...profile, id: userId, ...(presence ? { presence } : {}) } : undefined
  }, [userId, preview, profile, presence])
}

export function useAttentionScopes(): readonly AttentionScopeRow[] {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ scope: registry.collections.attentionScopes })
      : undefined,
  })
  return (result.data ?? []) as AttentionScopeRow[]
}

export function useAttentionItems(): readonly AttentionItemRow[] {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ item: registry.collections.attentionItems })
      : undefined,
  })
  return (result.data ?? []) as AttentionItemRow[]
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

export type CanonicalForumSidebarThread = {
  id: string
  parentChannelId: string
  parentMessageId: string
  title: string
  activityAt: string
  expiresAt: string
  unread: boolean
}

const FORUM_SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000

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
    const viewerId = rows.registry.accountId
    const participating = new Set(rows.channelMemberships
      .filter((membership) => (
        membership.relation === "notify"
        && membership.userId === viewerId
      ))
      .map((membership) => membership.channelId))
    const messageById = new Map(rows.messages.map((message) => [message.id, message]))
    const candidates: CanonicalForumSidebarThread[] = rows.channels
      .filter((channel) => (
        channel.serverId === serverId
        && channel.type === "thread"
        && !channel.archived
        && participating.has(channel.id)
        && channel.parentChannelId
        && channel.parentMessageId
      ))
      .map((channel) => {
        const activityAt = channel.lastMessageAt ?? ""
        const activityMs = Date.parse(activityAt)
        return {
          id: channel.id,
          parentChannelId: channel.parentChannelId!,
          parentMessageId: channel.parentMessageId!,
          title: messageById.get(channel.parentMessageId!)?.content ?? channel.name,
          activityAt,
          expiresAt: Number.isFinite(activityMs)
            ? new Date(activityMs + FORUM_SIDEBAR_ACTIVITY_WINDOW_MS).toISOString()
            : activityAt,
          unread: channel.unread,
        }
      })
      .filter((thread) => (
        thread.id === retainId
        || !Number.isFinite(Date.parse(thread.expiresAt))
        || Date.parse(thread.expiresAt) > serverNowMs
      ))
      .sort((left, right) => (
        left.parentChannelId.localeCompare(right.parentChannelId)
        || right.activityAt.localeCompare(left.activityAt)
        || right.id.localeCompare(left.id)
      ))
    const byParent = new Map<string, CanonicalForumSidebarThread[]>()
    for (const thread of candidates) {
      const siblings = byParent.get(thread.parentChannelId) ?? []
      siblings.push(thread)
      byParent.set(thread.parentChannelId, siblings)
    }
    const threads = [...byParent.values()].flatMap((siblings) => {
      const retained = retainId
        ? siblings.find((thread) => thread.id === retainId)
        : undefined
      if (!retained) return siblings.slice(0, 5)
      if (siblings.slice(0, 5).some((thread) => thread.id === retained.id)) {
        return siblings.slice(0, 5)
      }
      return [...siblings.filter((thread) => thread.id !== retained.id).slice(0, 4), retained]
        .sort((left, right) => (
          right.activityAt.localeCompare(left.activityAt)
          || right.id.localeCompare(left.id)
        ))
    })
    const renderedIds = new Set(threads.map((thread) => thread.id))
    const parentUnread: Record<string, boolean> = {}
    for (const parent of rows.channels.filter((channel) => (
      channel.serverId === serverId && channel.type === "forum"
    ))) {
      parentUnread[parent.id] = parent.baseUnread ?? parent.unread
    }
    for (const child of rows.channels) {
      if (
        child.serverId === serverId
        && child.type === "thread"
        && child.unread
        && child.parentChannelId
        && !renderedIds.has(child.id)
      ) {
        parentUnread[child.parentChannelId] = true
      }
    }
    return { threads, parentUnread }
  }, [serverNowMs, rows.registry, rows.channels, rows.channelMemberships, rows.messages, serverId, retainId])
}
