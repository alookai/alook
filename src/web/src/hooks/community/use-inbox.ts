"use client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useMemo } from "react"
import {
useQuery,
useMutationState,
useQueryClient,
type QueryClient,
type QueryFunctionContext,
type UseQueryResult,
} from "@tanstack/react-query"

import { apiFetch } from "@/lib/api/client"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import { COMMUNITY_INBOX_CONTEXT_HEADER, type CommunityResourceBundle } from "@alook/shared"
import type {
InboxFriendRequest,
InboxTodo,
Marked,
Mention,
UnreadDm,
UnreadServer,
} from "@/lib/community/models/inbox"
import { communityScopeAllowsAccess } from "@/stores/community/ws-store"
import { communityServerRetirementId, communityServerRetirementKey } from "@/lib/community-db/message-access-scope"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
materializeCanonicalMessage,
useOptionalCommunityDbRegistry,
useChannelsByIds,
useCanonicalIdentitiesByUserId,
useCanonicalMessagesById,
useCanonicalServersById,
useDmProjection,
} from "@/lib/community-db/projections"
import {
assertCommunityLiveSnapshotTokenCurrent,
captureCommunityLiveSnapshotToken,
publishCommunityResourceBundle,
} from "@/lib/community-db/sync"
import { useAccountAttentionProjection } from "./use-account-attention"

class StaleReadError extends Error {
  constructor() {
    super("stale D1 read")
    this.name = "StaleReadError"
  }
}

function throwIfStale<T extends { stale?: boolean }>(value: T): T {
  if (value.stale) throw new StaleReadError()
  return value
}

const EMPTY_MARKED: readonly Marked[] = Object.freeze([])

type ProjectedUnreadChannel = UnreadServer["channels"][number]

/**
 * The account attention snapshot is the only source for the badge, Unreads,
 * Mentions, and friend-request rows. All owner records arrive in that same
 * fenced response and are published atomically with its scopes and items.
 */
export function useInboxAttention() {
  const query = useAccountAttentionProjection()
  const registry = useOptionalCommunityDbRegistry()
  const viewerId = registry?.accountId ?? null
  const channelIds = useMemo(() => {
    const ids = new Set<string>()
    for (const scope of query.scopes) {
      ids.add(scope.channelId)
      if (scope.parentChannelId) ids.add(scope.parentChannelId)
    }
    for (const item of query.items) {
      if (item.scopeId) ids.add(item.scopeId)
      if (item.childChannelId) ids.add(item.childChannelId)
    }
    return [...ids]
  }, [query.items, query.scopes])
  const channelsById = useChannelsByIds(channelIds, channelIds.length > 0)
  const messageIds = useMemo(() => [...new Set(query.items.flatMap((item) => item.messageId ? [item.messageId] : []))], [query.items])
  const messagesById = useCanonicalMessagesById(messageIds)
  const friendRequestActorIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of query.items) {
      if (item.kind === "friend_request" && item.actorUserId) ids.add(item.actorUserId)
    }
    return [...ids]
  }, [query.items])
  const profilesById = useCanonicalIdentitiesByUserId(friendRequestActorIds, friendRequestActorIds.length > 0)
  const serversById = useCanonicalServersById()
  const dmProjection = useDmProjection({ includePresence: false })

  const projected = useMemo(() => {
    const scopesById = new Map(query.scopes.map((scope) => [scope.scopeId, scope]))
    const dmById = new Map((dmProjection ?? []).map((dm) => [dm.id, dm]))
    const grouped = new Map<string, Map<string, ProjectedUnreadChannel>>()
    const dms: UnreadDm[] = []

    for (const scope of query.scopes) {
      if (!scope.ordinaryUnread && scope.attentionCount <= 0) continue
      const channel = channelsById.get(scope.channelId)
      if (!scope.serverId) {
        const dm = dmById.get(scope.channelId)
        if (!channel || !dm) continue
        dms.push({
          channelId: dm.id,
          otherUserId: dm.userId,
          otherUserName: dm.name,
          otherUserDiscriminator: dm.discriminator,
          otherUserAvatar: dm.avatar,
          otherUserAvatarVersion: dm.avatarVersion,
          lastMessageAt: channel.lastMessageAt ?? "",
          lastUnreadSeq: Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0),
          unreadCount: scope.unreadCount,
        })
        continue
      }
      if (!channel) continue
      const serverChannels = grouped.get(scope.serverId) ?? new Map<string, ProjectedUnreadChannel>()
      grouped.set(scope.serverId, serverChannels)

      if (scope.parentChannelId) {
        const parent = channelsById.get(scope.parentChannelId)
        if (!parent) continue
        const parentRow = serverChannels.get(parent.id) ?? {
          channelId: parent.id,
          channelName: parent.name ?? "",
          type: parent.type === "forum" ? "forum" : "text",
          lastMessageAt: parent.lastMessageAt ?? "",
          mentionCount: 0,
          hasDirectUnread: false,
          children: [],
        }
        parentRow.children.push({
          channelId: channel.id,
          channelName: channel.name ?? "",
          type: "thread",
          lastMessageAt: channel.lastMessageAt ?? "",
          lastUnreadSeq: Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0),
          unreadCount: scope.unreadCount,
          mentionCount: scope.attentionCount,
          parentChannelId: parent.id,
          ...(channel.parentMessageId ? { openerMessageId: channel.parentMessageId } : {}),
          ...(channel.openerSeq === undefined ? {} : { openerSeq: channel.openerSeq }),
          ...(channel.openerUnread === undefined ? {} : { openerUnread: channel.openerUnread }),
        })
        serverChannels.set(parent.id, parentRow)
        continue
      }

      const previous = serverChannels.get(channel.id)
      serverChannels.set(channel.id, {
        channelId: channel.id,
        channelName: channel.name ?? "",
        type: channel.type === "forum" ? "forum" : "text",
        lastMessageAt: channel.lastMessageAt ?? "",
        lastUnreadSeq: Math.max(scope.lastUnreadSeq, scope.lastAttentionSeq ?? 0),
        unreadCount: scope.unreadCount,
        mentionCount: scope.attentionCount,
        hasDirectUnread: scope.ordinaryUnread || scope.attentionCount > 0,
        children: previous?.children ?? [],
      })
    }

    for (const item of query.items) {
      if (item.kind !== "forum_post" || !item.scopeId || !item.childChannelId || !item.messageId || item.openerSeq === undefined) continue
      const scope = scopesById.get(item.scopeId)
      const parent = scope ? channelsById.get(scope.channelId) : undefined
      const child = channelsById.get(item.childChannelId)
      if (!scope?.serverId || !parent || child?.parentChannelId !== parent.id || child.parentMessageId !== item.messageId) continue
      const serverChannels = grouped.get(scope.serverId) ?? new Map<string, ProjectedUnreadChannel>()
      grouped.set(scope.serverId, serverChannels)
      const previous = serverChannels.get(parent.id)
      serverChannels.set(parent.id, {
        channelId: parent.id,
        channelName: parent.name ?? "",
        type: "forum",
        lastMessageAt: parent.lastMessageAt ?? "",
        lastUnreadSeq: Math.max(previous?.lastUnreadSeq ?? 0, scope.lastUnreadSeq, item.openerSeq),
        unreadCount: scope.unreadCount,
        mentionCount: scope.attentionCount,
        hasDirectUnread: true,
        children: previous?.children ?? [],
        forumOpeners: [...(previous?.forumOpeners ?? []), {
          channelId: child.id,
          channelName: child.name ?? "",
          type: "thread",
          lastMessageAt: child.lastMessageAt ?? "",
          mentionCount: 0,
          parentChannelId: parent.id,
          openerMessageId: item.messageId,
          openerSeq: item.openerSeq,
          openerUnread: true,
        }],
      })
    }

    const servers: UnreadServer[] = [...grouped].flatMap(([serverId, rows]) => {
      const server = serversById.get(serverId)
      if (!server) return []
      const channels = [...rows.values()]
        .map((channel) => ({
          ...channel,
          children: channel.children
            .slice()
            .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt)),
        }))
        .sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
      return [{ serverId, serverName: server.name, serverIcon: server.icon, channels }]
    })
    dms.sort((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))

    const friendRequests: InboxFriendRequest[] = query.items.flatMap((item) => {
      if (item.kind !== "friend_request" || !item.actorUserId) return []
      const profile = profilesById.get(item.actorUserId)
      if (!profile) return []
      return [{
        id: item.sourceId,
        userId: item.actorUserId,
        name: profile.name ?? "Deleted user",
        avatar: profile.avatar ?? "",
        avatarVersion: profile.avatarVersion ?? null,
        createdAt: item.createdAt,
      }]
    })

    const mentions: Mention[] = query.items.flatMap((item) => {
      if (
        item.kind !== "mention" && item.kind !== "reply"
        || !item.scopeId
        || !item.messageId
      ) return []
      const scope = scopesById.get(item.scopeId)
      const channel = scope ? channelsById.get(scope.channelId) : undefined
      const message = messagesById?.get(item.messageId)
      if (!scope || !channel || !message) return []
      return [{
        id: item.sourceId,
        kind: item.kind,
        server: scope.serverId
          ? serversById.get(scope.serverId)?.name ?? ""
          : dmById.get(scope.channelId)?.name ?? "",
        ...(scope.serverId ? { serverId: scope.serverId } : {}),
        channel: channel.name ?? "",
        channelId: channel.id,
        m: message,
      }]
    })

    const todos: InboxTodo[] = query.items.flatMap((item) => {
      if (item.kind !== "question" || !item.scopeId || !item.messageId) return []
      const channel = channelsById.get(item.scopeId)
      const message = messagesById?.get(item.messageId)
      if (!channel || !message?.decisionCard) return []
      if (viewerId && message.decisionCard.respondedUserIds?.includes(viewerId)) return []
      const serverId = channel.serverId ?? null
      const dm = !serverId ? dmById.get(channel.id) : undefined
      return [{
        id: item.id,
        messageId: item.messageId,
        channelId: channel.id,
        serverId,
        server: serverId
          ? serversById.get(serverId)?.name ?? ""
          : dm?.name ?? "",
        channel: channel.name ?? dm?.name ?? "",
        parentChannelId: channel.parentChannelId ?? null,
        createdAt: item.createdAt,
        m: message,
      }]
    })

    const conversations = new Set<string>()
    for (const server of servers) {
      for (const channel of server.channels) {
        if (channel.hasDirectUnread !== false) conversations.add(channel.channelId)
        for (const child of channel.children) conversations.add(child.channelId)
      }
    }
    for (const dm of dms) conversations.add(dm.channelId)
    for (const mention of mentions) conversations.add(mention.channelId ?? mention.id)
    for (const todo of todos) conversations.add(todo.channelId)
    const exactAttentionCount = conversations.size + friendRequests.length

    return { servers, dms, mentions, todos, friendRequests, exactAttentionCount }
  }, [
    channelsById,
    dmProjection,
    messagesById,
    profilesById,
    query.items,
    query.scopes,
    serversById,
    viewerId,
  ])

  return {
    ...query,
    ...projected,
    hasUnread: projected.servers.length > 0 || projected.dms.length > 0,
    hasMention: projected.mentions.length > 0,
    hasTodo: projected.todos.length > 0,
    todosTruncated: Boolean(query.data?.todosTruncated),
    hasProjectedUnread: projected.servers.length > 0 || projected.dms.length > 0,
    hasProjectedMention: projected.mentions.length > 0,
    hasOutstandingFriendRequest: projected.friendRequests.length > 0,
    isLoading: query.data === undefined && !query.isError,
    isInitialError: query.data === undefined && query.isError,
  }
}

/** Compatibility alias for the friend-request counter in the DM layout. */
export function useInboxUnreads() {
  return useInboxAttention()
}

type MarkedResponse = MarkedWindowResponse & { resources: CommunityResourceBundle }
type MarkedWindowResponse = { marked: Array<Omit<Marked, "m"> & { m: Pick<Marked["m"], "id"> }> }

const inboxMarkedQueryFn = (queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
    const data = throwIfStale(await apiFetchCommunity<MarkedResponse & { stale?: boolean }>(
      "/api/community/users/me/marks",
      { signal, headers: { [COMMUNITY_INBOX_CONTEXT_HEADER]: "1" } }, publicationToken,
    ))
    await publishCommunityResourceBundle(queryClient, data.resources, { token: publicationToken, signal }, data.marked.map(row => ({ id: row.m.id, channelId: row.channelId })))
    return { marked: data.marked.map((row) => ({ ...row, m: { id: row.m.id } })) }
  }

export function useInboxMarked(enabled: boolean): UseQueryResult<MarkedWindowResponse> & {
  marked: Marked[]
  canonicalPending: boolean
  isDisplayReady: boolean
  isInitialError: boolean
} {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: communityKeys.inboxMarked(),
    queryFn: inboxMarkedQueryFn(queryClient),
    enabled,
  })
  const messageIds = useMemo(() => enabled ? (query.data?.marked.map((row) => row.m.id) ?? []) : [], [enabled, query.data?.marked])
  const canonicalMessages = useCanonicalMessagesById(messageIds)
  const pendingMarks = useMutationState({ filters: { mutationKey: ["community", "mark-command"], status: "pending" }, select: (mutation) => ({ messageId: (mutation.state.variables as { messageId: string }).messageId, marked: mutation.options.mutationKey?.[2] === true }) })
  const registry = useOptionalCommunityDbRegistry()
  const retiringServers = useMutationState({ filters: { mutationKey: communityServerRetirementKey, status: "pending" }, select: mutation => communityServerRetirementId(mutation, registry) })
  const revokedServerIds = useCommunityWsStore((state) => state.revokedServerIds)
  const channelAccessScopes = useCommunityWsStore((state) => state.channelAccessScopes)
  const eligible = useMemo(() => {
    const source = query.data?.marked ?? (EMPTY_MARKED as Marked[])
    if (!enabled || source.length === 0) return EMPTY_MARKED as Marked[]
    const latestPendingMark = new Map<string, boolean>()
    for (const command of pendingMarks) latestPendingMark.set(command.messageId, command.marked)
    const retiringSet = new Set(retiringServers)
    const accessState = { revokedServerIds, channelAccessScopes }
    return source.filter(marked => latestPendingMark.get(marked.m.id) !== false
      && communityScopeAllowsAccess(accessState, marked) && !(marked.serverId && retiringSet.has(marked.serverId)))
  }, [enabled, query.data?.marked, revokedServerIds, channelAccessScopes, pendingMarks, retiringServers])
  const marked = useMemo(() => {
    return eligible.flatMap((marked) => {
      const message = materializeCanonicalMessage(marked.m, canonicalMessages)
      return message ? [{ ...marked, m: message }] : []
    })
  }, [canonicalMessages, eligible])
  const isDisplayReady = query.data !== undefined && marked.length === eligible.length
  return { ...query, marked, isDisplayReady, isInitialError: query.isError && !isDisplayReady,
    canonicalPending: enabled && !!query.data && !query.isError && !isDisplayReady }
}

export type MessageMarkedResponse = { marked: boolean }

const messageMarkedQueryFn = (messageId: string) => async ({ client, signal }: QueryFunctionContext) => {
  const original = captureCommunityLiveSnapshotToken(client), key = communityKeys.messageMarked(messageId)
  if (!original.registry) throw new DOMException("Missing personal Marked owner", "AbortError")
  const query = client.getQueryCache().find({ queryKey: key, exact: true }), baseline = query?.state.dataUpdateCount
  const auxiliaryReadEpoch = await original.registry!.captureAuxiliaryReadEpoch()
  const assert = () => {
    assertCommunityLiveSnapshotTokenCurrent(client, original, signal)
    if (query && (client.getQueryCache().find({ queryKey: key, exact: true }) !== query || query.state.dataUpdateCount !== baseline)) throw new DOMException("Retired personal Marked read", "AbortError")
  }
  assert()
  const data = throwIfStale(await apiFetch<MessageMarkedResponse & { stale?: boolean }>(
    `/api/community/messages/${messageId}/marks`, communityRequestOptions(client, original, signal, assert)))
  assert()
  if (client.getMutationCache().findAll({ mutationKey: ["community", "mark-command"], status: "pending", predicate: mutation => (mutation.state.variables as { messageId: string }).messageId === messageId }).length)
    throw new DOMException("Personal Marked command is pending", "AbortError")
  if (typeof data.marked !== "boolean") throw new Error("Invalid personal Marked response")
  const message = original.registry.collections.messages.get(messageId)
  const channel = message ? original.registry.collections.channels.get(message.channelId) : undefined
  const scopeRef = message ? { channelId: message.channelId, ...(channel ? { serverId: channel.serverId, parentChannelId: channel.parentChannelId } : {}) } : undefined
  return { marked: data.marked, ...(scopeRef ? { scopeRef } : {}), observed: true, ...(auxiliaryReadEpoch ? { auxiliaryReadEpoch } : {}) }
}

export function useMessageMarked(
  messageId: string,
  enabled: boolean,
): UseQueryResult<MessageMarkedResponse> {
  const query = useQuery({
    queryKey: communityKeys.messageMarked(messageId),
    queryFn: messageMarkedQueryFn(messageId),
    enabled,
    staleTime: 30_000,
  })
  const pending = useMutationState({ filters: { mutationKey: ["community", "mark-command"], status: "pending", predicate: (mutation) => (mutation.state.variables as { messageId: string }).messageId === messageId }, select: (mutation) => mutation.options.mutationKey?.[2] === true }).at(-1)
  return { ...query, data: pending === undefined ? query.data : { marked: pending } } as UseQueryResult<MessageMarkedResponse>
}
