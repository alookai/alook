"use client"

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react"
import { and, DbProvider, eq, useLiveQuery } from "@tanstack/react-db"
import { notifLevelDisplay } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import type { DM, Member } from "@/lib/community/models/people"
import { sortDmsByActivity } from "@/lib/community/dm-order"
import type { CommunityProfile } from "@/lib/community/models/people"
import type { Category, CommunityFolder, Server } from "@/lib/community/models/navigation"
import type { Msg } from "@/lib/community/models/message"
import type { ChannelRefDirectory } from "@/lib/community/channel-ref"
import type { CommunityDbRegistry } from "./collections"
import {
  readMessageSequenceState,
  type MessageCollectionDemand,
  type MessageSequenceState,
  type MessageWindowLease,
} from "./message-resource"
import {
  readServerMembersState,
  type ServerMembersLease,
  type ServerMembersState,
} from "./server-members-resource"
import { useCommunityPreviewProfiles } from "@/stores/community/profile-preview"
import { useCommunityWsStore } from "@/stores/community/ws"
import type {
  AttentionItemRow,
  AttentionScopeRow,
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
const noCollectionReadiness = () => 0

type CommunityCollectionName = keyof CommunityDbRegistry["collections"]

function useCollectionReady(
  registry: CommunityDbRegistry | null,
  name: CommunityCollectionName,
) {
  useSyncExternalStore(
    registry?.subscribeCollectionReadiness ?? subscribeToNoRestoredCollections,
    registry?.getCollectionReadinessSnapshot ?? noCollectionReadiness,
    noCollectionReadiness,
  )
  return registry ? (registry.isCollectionReady?.(name) ?? true) : false
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
  useSyncExternalStore(
    registry?.subscribeCollectionReadiness ?? subscribeToNoRestoredCollections,
    registry?.getCollectionReadinessSnapshot ?? noCollectionReadiness,
    noCollectionReadiness,
  )
  const ready = (name: CommunityCollectionName) => (
    registry ? (registry.isCollectionReady?.(name) ?? true) : false
  )
  const servers = useLiveQuery({
    query: (q) => registry
      ? q.from({ server: registry.collections.servers })
      : undefined,
  }).data as ServerRow[] | undefined
  const categories = useLiveQuery({
    query: (q) => registry && ready("categories")
      ? q.from({ category: registry.collections.categories })
      : undefined,
  }).data as CategoryRow[] | undefined
  const channels = useLiveQuery({
    query: (q) => registry && ready("channels")
      ? q.from({ channel: registry.collections.channels })
      : undefined,
  }).data as ChannelRow[] | undefined
  const serverMemberships = useLiveQuery({
    query: (q) => registry && ready("serverMemberships")
      ? q.from({ membership: registry.collections.serverMemberships })
      : undefined,
  }).data as ServerMembershipRow[] | undefined
  const channelMemberships = useLiveQuery({
    query: (q) => registry && ready("channelMemberships")
      ? q.from({ membership: registry.collections.channelMemberships })
      : undefined,
  }).data as ChannelMembershipRow[] | undefined
  const profiles = useLiveQuery({
    query: (q) => registry && ready("profiles")
      ? q.from({ profile: registry.collections.profiles })
      : undefined,
  }).data as ProfileRow[] | undefined
  const messages = useLiveQuery({
    query: (q) => registry && ready("messages")
      ? q.from({ message: registry.collections.messages })
      : undefined,
  }).data as MessageRow[] | undefined
  const readStates = useLiveQuery({
    query: (q) => registry && ready("readStates")
      ? q.from({ readState: registry.collections.readStates })
      : undefined,
  }).data as ReadStateRow[] | undefined
  const folders = useLiveQuery({
    query: (q) => registry && ready("folders")
      ? q.from({ folder: registry.collections.folders })
      : undefined,
  }).data as FolderRow[] | undefined
  const folderItems = useLiveQuery({
    query: (q) => registry && ready("folderItems")
      ? q.from({ item: registry.collections.folderItems })
      : undefined,
  }).data as FolderItemRow[] | undefined
  const notificationSettings = useLiveQuery({
    query: (q) => registry && ready("notificationSettings")
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
    if (!rows.registry || !rows.servers) return undefined
    const servers: Server[] = rows.servers
      .map((server, fallbackPosition) => ({ server, fallbackPosition }))
      .sort((left, right) => (
        (left.server.position ?? left.fallbackPosition)
        - (right.server.position ?? right.fallbackPosition)
      ))
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
  }, [rows])
}

export function useServerTreeProjection(serverId: string | null) {
  const registry = useOptionalCommunityDbRegistry()
  const categoriesReady = useCollectionReady(registry, "categories")
  const channelsReady = useCollectionReady(registry, "channels")
  const servers = useLiveQuery({
    query: (q) => registry && serverId
      ? q.from({ server: registry.collections.servers })
        .where(({ server }) => eq(server.id, serverId))
      : undefined,
  }).data as ServerRow[] | undefined
  const categories = useLiveQuery({
    query: (q) => registry && categoriesReady && serverId
      ? q.from({ category: registry.collections.categories })
        .where(({ category }) => eq(category.serverId, serverId))
      : undefined,
  }).data as CategoryRow[] | undefined
  const channels = useLiveQuery({
    query: (q) => registry && channelsReady && serverId
      ? q.from({ channel: registry.collections.channels })
        .where(({ channel }) => eq(channel.serverId, serverId))
      : undefined,
  }).data as ChannelRow[] | undefined
  return useMemo(
    () => buildServerTreeProjection(serverId, servers, categories, channels, true),
    [categories, channels, serverId, servers],
  )
}

function buildServerTreeProjection(
  serverId: string | null,
  servers: readonly ServerRow[] | undefined,
  categoryRows: readonly CategoryRow[] | undefined,
  channelRows: readonly ChannelRow[] | undefined,
  descriptorReady = false,
) {
  if (!serverId || !servers || !categoryRows || !channelRows) return undefined
  const server = servers.find((candidate) => candidate.id === serverId)
  if (!server || (!server.detailComplete && !descriptorReady)) return undefined
  const channels = channelRows.filter((channel) => (
    channel.serverId === serverId && channel.type !== "thread"
  ))
  const categories: Category[] = categoryRows
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
}

export function readServerTreeProjection(
  registry: CommunityDbRegistry,
  serverId: string,
) {
  if (
    !registry.isCollectionReady("categories")
    || !registry.isCollectionReady("channels")
  ) return undefined
  const server = registry.collections.servers.get(serverId)
  if (!server) return undefined
  return buildServerTreeProjection(
    serverId,
    [server],
    Array.from(registry.collections.categories.values()),
    Array.from(registry.collections.channels.values()),
  )
}

export function useDmProjection() {
  const rows = useCollectionRows()
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
  }, [rows])
}

export function useRouteChannelProjection(
  channelId: string | null,
  serverId?: string | null,
) {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "channels")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ channel: registry.collections.channels })
        .where(({ channel }) => serverId
          ? and(eq(channel.id, channelId ?? ""), eq(channel.serverId, serverId))
          : eq(channel.id, channelId ?? ""))
      : undefined,
  })
  return useMemo(() => {
    if (!channelId || !result.data) return undefined
    return (result.data as ChannelRow[]).find((row) => row.id === channelId)
  }, [channelId, result.data])
}

export function useReadStateProjection(channelId: string | null | undefined) {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "readStates")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ readState: registry.collections.readStates })
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

export function useMessageProjection(
  channelId: string | null,
) {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "messages")
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!registry || !ready) return
    const subscription = registry.collections.messages.subscribeChanges(() => {
      setRevision((current) => current + 1)
    }, { includeInitialState: true })
    return () => subscription.unsubscribe()
  }, [ready, registry])
  return useMemo(() => {
    void revision
    if (!channelId || !registry || !ready) return undefined
    return [...registry.collections.messages.values()]
      .filter((message) => message.channelId === channelId)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((message) => {
        const { channelId: _channelId, replyToId: _replyToId, ...model } = message
        return model as Msg
      })
  }, [channelId, ready, registry, revision])
}

export function useCanonicalMessagesById(): ReadonlyMap<string, Msg> | undefined {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "messages")
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!registry || !ready) return
    const subscription = registry.collections.messages.subscribeChanges(() => {
      setRevision((current) => current + 1)
    }, { includeInitialState: true })
    return () => subscription.unsubscribe()
  }, [ready, registry])
  return useMemo(() => {
    void revision
    return !registry || !ready ? undefined : new Map(
      [...registry.collections.messages.values()].map((message) => {
        const { channelId: _channelId, replyToId: _replyToId, ...model } = message
        return [message.id, model as Msg]
      }),
    )
  }, [ready, registry, revision])
}

const EMPTY_MESSAGE_SEQUENCE_STATE: MessageSequenceState = {
  fetchStatus: "idle",
  hasMore: false,
  latestSeq: 0,
  loadedRows: 0,
  rowIds: [],
  rows: [],
  status: "pending",
}

function useMessageSequenceState(
  registry: CommunityDbRegistry | null,
  demand: MessageCollectionDemand | undefined,
) {
  const subscribe = useCallback((listener: () => void) => {
    if (!registry || !demand) return () => {}
    return registry.queryClient.getQueryCache().subscribe(listener)
  }, [demand, registry])
  const getSnapshot = useCallback(() => {
    if (!registry || !demand) return JSON.stringify(EMPTY_MESSAGE_SEQUENCE_STATE)
    return JSON.stringify(readMessageSequenceState(registry.queryClient, demand))
  }, [demand, registry])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(
    () => JSON.parse(snapshot) as MessageSequenceState,
    [snapshot],
  )
}

function messageAcquisitionKey(
  demand: MessageCollectionDemand | undefined,
) {
  if (!demand) return ["community-message-acquisition", "disabled"] as const
  return [
    "community-message-acquisition",
    demand.scope.accountId,
    demand.scope.kind,
    demand.scope.serverId,
    demand.scope.channelId,
    demand.tag,
    demand.sequence.base.mode === "anchor"
      ? `anchor:${demand.sequence.base.anchor}`
      : "tail",
    demand.sequence.direction,
  ] as const
}

function useMessageWindowLease(
  registry: CommunityDbRegistry | null,
  demand: MessageCollectionDemand | undefined,
  limit: number,
) {
  const identity = JSON.stringify(messageAcquisitionKey(demand))
  const limitRef = useRef(limit)
  const leaseRef = useRef<{
    identity: string
    lease: MessageWindowLease
  } | null>(null)
  useLayoutEffect(() => {
    limitRef.current = limit
  }, [limit])
  useEffect(() => {
    if (!registry || !demand) return
    const lease = registry.acquireMessageWindow(demand, limitRef.current)
    leaseRef.current = { identity, lease }
    return () => {
      if (leaseRef.current?.lease === lease) leaseRef.current = null
      void lease.release()
    }
  }, [demand, identity, registry])
  useEffect(() => {
    const active = leaseRef.current
    if (!active || active.identity !== identity) return
    void active.lease.update(limit)
  }, [identity, limit])
}

export function useMessageWindowProjection({
  channelId,
  demand,
  newerLimit,
  olderLimit,
}: {
  channelId: string | null
  demand: MessageCollectionDemand | undefined
  newerLimit: number
  olderLimit: number
}) {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "messages")
  const olderDemand = useMemo(() => demand ? {
    ...demand,
    sequence: { ...demand.sequence, direction: "older" as const },
  } : undefined, [demand])
  const newerDemand = useMemo(() => demand?.sequence.base.mode === "anchor" ? {
    ...demand,
    sequence: { ...demand.sequence, direction: "newer" as const },
  } : undefined, [demand])
  if (registry && demand) registry.setMessageDemand(demand)
  useMessageWindowLease(registry, olderDemand, olderLimit)
  useMessageWindowLease(registry, newerDemand, newerLimit)
  const ownerLimit = demand?.sequence.base.mode === "anchor" ? 26 : 50
  const older = useLiveQuery({
    client: registry?.dbClient,
    queryKey: messageAcquisitionKey(olderDemand),
    query: (q) => registry && ready && channelId && olderDemand
      ? q.from({ message: registry.collections.messages })
        .where(({ message }) => eq(message.channelId, channelId))
        .orderBy(({ message }) => message.seq, "desc")
        .orderBy(({ message }) => message.id, "desc")
        .limit(ownerLimit)
      : undefined,
  })
  const newer = useLiveQuery({
    client: registry?.dbClient,
    queryKey: messageAcquisitionKey(newerDemand),
    query: (q) => registry && ready && channelId && newerDemand
      ? q.from({ message: registry.collections.messages })
        .where(({ message }) => eq(message.channelId, channelId))
        .orderBy(({ message }) => message.seq, "asc")
        .orderBy(({ message }) => message.id, "asc")
        .limit(ownerLimit)
      : undefined,
  })
  const canonicalMessages = useMessageProjection(channelId)
  const olderState = useMessageSequenceState(registry, olderDemand)
  const newerState = useMessageSequenceState(registry, newerDemand)
  const messages = useMemo(() => {
    if (!canonicalMessages) return undefined
    const byId = new Map<string, Msg>()
    for (const row of [
      ...olderState.rows,
      ...newerState.rows,
    ]) {
      const { channelId: _channelId, replyToId: _replyToId, ...message } = row
      byId.set(row.id, message as Msg)
    }
    for (const message of canonicalMessages) byId.set(message.id, message)
    return [...new Set([...olderState.rowIds, ...newerState.rowIds])]
      .flatMap((id) => {
        const message = byId.get(id)
        return message ? [message] : []
      })
      .sort((left, right) => (
        (left.seq ?? 0) - (right.seq ?? 0) || left.id.localeCompare(right.id)
      ))
  }, [canonicalMessages, newerState, olderState])
  const reset = useCallback(async () => {
    if (!registry || !demand) return
    await registry.resetMessageDemand(demand)
  }, [demand, registry])
  return {
    hasMoreNewer: newerDemand ? newerState.hasMore : false,
    hasMoreOlder: olderState.hasMore,
    isError: older.isError || newer.isError,
    isFetchingNewer: newerDemand !== undefined && (
      newer.isLoading || newerState.fetchStatus === "fetching"
    ),
    isFetchingOlder: older.isLoading || olderState.fetchStatus === "fetching",
    isPending: older.isLoading || (newerDemand !== undefined && newer.isLoading),
    latestSeq: Math.max(
      olderState.latestSeq,
      newerState.latestSeq,
      ...(messages ?? []).map((message) => message.seq ?? 0),
    ),
    messages,
    refetch: reset,
  }
}

export function useCanonicalChannelsById(): ReadonlyMap<string, ChannelRow> {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "channels")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ channel: registry.collections.channels })
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ChannelRow[]).map((channel) => [channel.id, channel]),
  ), [result.data])
}

export function useCanonicalServersById(): ReadonlyMap<string, ServerRow> {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "servers")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ server: registry.collections.servers })
      : undefined,
  })
  return useMemo(() => new Map(
    ((result.data ?? []) as ServerRow[]).map((server) => [server.id, server]),
  ), [result.data])
}

export function materializeCanonicalMessage(
  transport: Msg,
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg | undefined {
  return canonical === undefined ? transport : canonical.get(transport.id)
}

export function materializeCanonicalMessages(
  transport: readonly Msg[],
  canonical: ReadonlyMap<string, Msg> | undefined,
): Msg[] {
  return canonical === undefined
    ? [...transport]
    : transport.flatMap((message) => {
        const row = canonical.get(message.id)
        return row ? [row] : []
      })
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
  const ready = useCollectionReady(registry, "profiles")
  const result = useLiveQuery({
    query: (q) => registry && ready
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

const EMPTY_SERVER_MEMBERS_STATE: ServerMembersState = {
  fetchStatus: "idle",
  hasMore: false,
  loadedRows: 0,
  status: "pending",
  total: 0,
}

function useServerMembersState(
  registry: CommunityDbRegistry | null,
  serverId: string | null,
) {
  const subscribe = useCallback((listener: () => void) => {
    if (!registry || !serverId) return () => {}
    return registry.queryClient.getQueryCache().subscribe(listener)
  }, [registry, serverId])
  const getSnapshot = useCallback(() => JSON.stringify(
    registry && serverId
      ? readServerMembersState(registry.queryClient, registry.scopeId, serverId)
      : EMPTY_SERVER_MEMBERS_STATE,
  ), [registry, serverId])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(() => JSON.parse(snapshot) as ServerMembersState, [snapshot])
}

function useServerMembersLease(
  registry: CommunityDbRegistry | null,
  serverId: string | null,
  limit: number,
) {
  const identity = `${registry?.scopeId ?? "none"}:${serverId ?? "none"}`
  const limitRef = useRef(limit)
  const leaseRef = useRef<{ identity: string; lease: ServerMembersLease } | null>(null)
  useLayoutEffect(() => {
    limitRef.current = limit
  }, [limit])
  useEffect(() => {
    if (!registry || !serverId) return
    const lease = registry.acquireServerMembers(serverId, limitRef.current)
    leaseRef.current = { identity, lease }
    return () => {
      if (leaseRef.current?.lease === lease) leaseRef.current = null
      void lease.release()
    }
  }, [identity, registry, serverId])
  useEffect(() => {
    const active = leaseRef.current
    if (!active || active.identity !== identity) return
    void active.lease.update(limit)
  }, [identity, limit])
}

export function useServerMembersProjection(serverId: string | null, limit: number) {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "serverMemberships")
  const profiles = useCanonicalProfilesByUserId()
  useServerMembersLease(registry, serverId, limit)
  const result = useLiveQuery({
    client: registry?.dbClient,
    queryKey: [
      "community-server-members-acquisition",
      registry?.scopeId ?? null,
      serverId,
      limit,
    ],
    query: (q) => registry && ready && serverId
      ? q.from({ membership: registry.collections.serverMemberships })
        .where(({ membership }) => eq(membership.serverId, serverId))
        .orderBy(({ membership }) => membership.id, "asc")
        .limit(limit)
      : undefined,
  })
  const state = useServerMembersState(registry, serverId)
  const members = useMemo<Member[]>(() => (
    ((result.data ?? []) as ServerMembershipRow[]).map((membership) => {
      const profile = profiles.get(membership.userId)
      const name = membership.nickname ?? profile?.name ?? ""
      return {
        id: membership.memberId ?? membership.userId,
        userId: membership.userId,
        name,
        discriminator: profile?.discriminator ?? "",
        avatar: profile?.avatar ?? avatarInitial(name),
        avatarVersion: profile?.avatarVersion ?? 0,
        status: profile?.presence ?? (membership.viewer ? "online" : "offline"),
        sub: "",
        role: membership.role as Member["role"],
        statusEmoji: profile?.statusEmoji,
        statusText: profile?.statusText,
      }
    })
  ), [profiles, result.data])
  return {
    failed: result.isError || state.status === "error",
    hasMore: state.hasMore,
    loading: Boolean(serverId) && (
      result.isLoading || (state.fetchStatus === "fetching" && state.loadedRows === 0)
    ),
    loadingMore: state.fetchStatus === "fetching" && state.loadedRows > 0,
    members,
    total: state.total,
  }
}

export function useAttentionScopes(): readonly AttentionScopeRow[] {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "attentionScopes")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ scope: registry.collections.attentionScopes })
      : undefined,
  })
  return (result.data ?? []) as AttentionScopeRow[]
}

export function useAttentionItems(): readonly AttentionItemRow[] {
  const registry = useOptionalCommunityDbRegistry()
  const ready = useCollectionReady(registry, "attentionItems")
  const result = useLiveQuery({
    query: (q) => registry && ready
      ? q.from({ item: registry.collections.attentionItems })
      : undefined,
  })
  return (result.data ?? []) as AttentionItemRow[]
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
  const rows = useCollectionRows()
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
  }, [retainId, rows, serverId, serverNowMs])
}
