"use client"

import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react"
import { DbProvider, useLiveQuery } from "@tanstack/react-db"
import { notifLevelDisplay } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import type { DM } from "@/lib/community/models/people"
import type { CommunityProfile } from "@/lib/community/models/people"
import type { Category, CommunityFolder, Server } from "@/lib/community/models/navigation"
import type { Msg } from "@/lib/community/models/message"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type { CommunityDbRegistry } from "./collections"
import { useCommunityPreviewProfiles } from "@/stores/community/profile-preview"
import { useCommunityWsStore } from "@/stores/community/ws"
import type {
  CategoryRow,
  ChannelMembershipRow,
  ChannelRow,
  FolderItemRow,
  FolderRow,
  MessageRow,
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

const subscribeToNoRestoredCollections = () => () => {}
const noRestoredPrimary = () => false

export function useTrustedRestoredPrimary() {
  const registry = useOptionalCommunityDbRegistry()
  return useSyncExternalStore(
    registry?.subscribeRestoredCollections ?? subscribeToNoRestoredCollections,
    () => Boolean(
      registry?.hasRestoredCollection("categories")
      && registry.hasRestoredCollection("channels"),
    ),
    noRestoredPrimary,
  )
}

export function CommunityDbProvider({
  registry,
  children,
}: {
  registry: CommunityDbRegistry
  children: ReactNode
}) {
  return createElement(
    DbProvider,
    { client: registry.dbClient },
    createElement(getCommunityDbContext().Provider, { value: registry }, children),
  )
}

function useCollectionRows() {
  const registry = useOptionalCommunityDbRegistry()
  const servers = useLiveQuery({
    query: (q) => registry
      ? q.from({ server: registry.collections.servers })
      : undefined,
  }).data as ServerRow[] | undefined
  const categories = useLiveQuery({
    query: (q) => registry
      ? q.from({ category: registry.collections.categories })
      : undefined,
  }).data as CategoryRow[] | undefined
  const channels = useLiveQuery({
    query: (q) => registry
      ? q.from({ channel: registry.collections.channels })
      : undefined,
  }).data as ChannelRow[] | undefined
  const serverMemberships = useLiveQuery({
    query: (q) => registry
      ? q.from({ membership: registry.collections.serverMemberships })
      : undefined,
  }).data as ServerMembershipRow[] | undefined
  const channelMemberships = useLiveQuery({
    query: (q) => registry
      ? q.from({ membership: registry.collections.channelMemberships })
      : undefined,
  }).data as ChannelMembershipRow[] | undefined
  const profiles = useLiveQuery({
    query: (q) => registry
      ? q.from({ profile: registry.collections.profiles })
      : undefined,
  }).data as ProfileRow[] | undefined
  const messages = useLiveQuery({
    query: (q) => registry
      ? q.from({ message: registry.collections.messages })
      : undefined,
  }).data as MessageRow[] | undefined
  const readStates = useLiveQuery({
    query: (q) => registry
      ? q.from({ readState: registry.collections.readStates })
      : undefined,
  }).data as ReadStateRow[] | undefined
  const folders = useLiveQuery({
    query: (q) => registry
      ? q.from({ folder: registry.collections.folders })
      : undefined,
  }).data as FolderRow[] | undefined
  const folderItems = useLiveQuery({
    query: (q) => registry
      ? q.from({ item: registry.collections.folderItems })
      : undefined,
  }).data as FolderItemRow[] | undefined
  const notificationSettings = useLiveQuery({
    query: (q) => registry
      ? q.from({ setting: registry.collections.notificationSettings })
      : undefined,
  }).data as NotificationSettingRow[] | undefined
  return {
    registry,
    servers,
    categories,
    channels,
    serverMemberships,
    channelMemberships,
    profiles,
    messages,
    readStates,
    folders,
    folderItems,
    notificationSettings,
  }
}

export function useServerRailProjection() {
  const rows = useCollectionRows()
  return useMemo(() => {
    if (!rows.registry || !rows.servers || !rows.serverMemberships) return undefined
    const viewerId = rows.registry.accountId
    const allowed = new Set(
      rows.serverMemberships
        .filter((membership) => membership.viewer && membership.userId === viewerId)
        .map((membership) => membership.serverId),
    )
    const servers: Server[] = rows.servers
      .filter((server) => allowed.has(server.id))
      .map((server) => ({
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
  }, [rows])
}

export function useServerTreeProjection(serverId: string | null) {
  const rows = useCollectionRows()
  return useMemo(() => {
    if (!serverId || !rows.servers || !rows.categories || !rows.channels) return undefined
    const server = rows.servers.find((candidate) => candidate.id === serverId)
    if (!server) return undefined
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
  }, [rows, serverId])
}

export function useDmProjection() {
  const rows = useCollectionRows()
  return useMemo(() => {
    const viewerId = rows.registry?.accountId
    if (!viewerId || !rows.channels || !rows.channelMemberships || !rows.profiles) return undefined
    const channelMemberships = rows.channelMemberships
    const profileById = new Map(rows.profiles.map((profile) => [profile.userId, profile]))
    const readStateByChannel = new Map((rows.readStates ?? []).map((state) => [state.channelId, state]))
    return rows.channels
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
          unread: channel.unread,
          ...(channel.lastUnreadSeq === undefined && !readState
            ? {}
            : { lastUnreadSeq: channel.lastUnreadSeq ?? readState?.lastReadSeq }),
        }]
      })
  }, [rows])
}

export function useRouteChannelProjection(channelId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ channel: registry.collections.channels })
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return (result.data as ChannelRow[]).find((row) => row.id === channelId)
  }, [channelId, result.data])
}

export function useMessageProjection(channelId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ message: registry.collections.messages })
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return (result.data as MessageRow[])
      .filter((message) => message.channelId === channelId)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((message) => {
        const { channelId: _channelId, replyToId: _replyToId, ...model } = message
        return model as Msg
      })
  }, [channelId, result.data])
}

export function useCanonicalMessagesById(): ReadonlyMap<string, Msg> | undefined {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ message: registry.collections.messages })
      : undefined,
  })
  return useMemo(() => !registry ? undefined : new Map(
    ((result.data ?? []) as MessageRow[]).map((message) => {
      const { channelId: _channelId, replyToId: _replyToId, ...model } = message
      return [message.id, model as Msg]
    }),
  ), [registry, result.data])
}

export function useCanonicalAccessScopeIds(): {
  serverIds: ReadonlySet<string>
  channelIds: ReadonlySet<string>
} | undefined {
  const rows = useCollectionRows()
  return useMemo(() => {
    if (!rows.registry) return undefined
    const serverIds = new Set((rows.servers ?? []).map((server) => server.id))
    return {
      serverIds,
      channelIds: new Set((rows.channels ?? []).flatMap((channel) => (
        channel.serverId === null || channel.serverId === undefined || serverIds.has(channel.serverId)
          ? [channel.id]
          : []
      ))),
    }
  }, [rows.channels, rows.registry, rows.servers])
}

export function useNotificationSettingsProjection() {
  const rows = useCollectionRows()
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

function useProfileProjectionMap() {
  const registry = useOptionalCommunityDbRegistry()
  const result = useLiveQuery({
    query: (q) => registry
      ? q.from({ profile: registry.collections.profiles })
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ProfileRow[]).map((profile) => [profile.userId, profile]),
  ), [result.data])
}

export function useCanonicalProfilesByUserId(): ReadonlyMap<string, CommunityProfile> {
  const previewProfiles = useCommunityPreviewProfiles()
  const canonicalProfiles = useProfileProjectionMap()
  const livePresence = useCommunityWsStore((state) => (
    previewProfiles ? null : state.presenceByUserId
  ))
  return useMemo(() => {
    if (previewProfiles) return previewProfiles
    const merged = new Map<string, CommunityProfile>()
    for (const [userId, profile] of canonicalProfiles) {
      merged.set(userId, { ...profile, id: userId })
    }
    for (const [userId, presence] of livePresence ?? []) {
      merged.set(userId, { ...merged.get(userId), id: userId, presence })
    }
    return merged
  }, [canonicalProfiles, livePresence, previewProfiles])
}

export function useCanonicalCommunityProfile(userId: string | null | undefined) {
  const profiles = useCanonicalProfilesByUserId()
  return userId ? profiles.get(userId) : undefined
}

export function useChannelRefDirectoryProjection(): ChannelRefDirectory | undefined {
  const rows = useCollectionRows()
  return useMemo(() => {
    if (!rows.servers || !rows.channels) return undefined
    const channels = rows.channels
    return rows.servers.map((server) => ({
      id: server.id,
      name: server.name,
      discriminator: server.discriminator,
      channels: channels
        .filter((channel) => channel.serverId === server.id)
        .map((channel) => ({ id: channel.id, name: channel.name })),
    }))
  }, [rows.channels, rows.servers])
}
