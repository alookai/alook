"use client"
import { useSelector } from "@tanstack/react-store"


import { deriveView, viewEvidence, valueEvidence } from "@/lib/observability/data-source"
import { useMemo } from "react"
import {
keepPreviousData,
useQuery,
useMutationState,
useQueryClient,
type QueryClient,
type QueryFunctionContext,
type UseQueryResult,
} from "@tanstack/react-query"
import { communityRequestOptions } from "@/lib/community-db/sync"
import { apiFetch } from "@/lib/api/client"
import { apiFetchCommunity } from "@/lib/community/account-cache-lifecycle"
import { communityKeys } from "@/lib/query-keys"
import type {
InboxFriendRequest,
Marked,
Mention,
UnreadDm,
UnreadServer,
} from "@/lib/community/models/inbox"
import { accountUnreadAllowsAccess,getActiveAccountUnreadProjection } from "./account-unread-projection"
import {
materializeCanonicalMessage,
useCanonicalChannelsById,
useCanonicalMessagesById,
useCanonicalProfilesByUserId,
useCanonicalServersById,
useDmProjection,
} from "@/lib/community-db/projections"
import {
captureCommunityLiveSnapshotToken,
publishCommunityEmbeddedMessages,
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
  const channelsById = useCanonicalChannelsById()
  const messageIds = useMemo(() => [...new Set(query.items.flatMap((item) => item.messageId ? [item.messageId] : []))], [query.items])
  const messagesById = useCanonicalMessagesById(messageIds)
  const profilesById = useCanonicalProfilesByUserId()
  const serversById = useCanonicalServersById()
  const dmProjection = useDmProjection()

  const projected = useMemo(() => {
    const scopesById = new Map(query.scopes.map((scope) => [scope.scopeId, scope]))
    const forumParentScopeIds = new Set(query.items.flatMap((item) => (
      item.kind === "forum_post" && item.scopeId ? [item.scopeId] : []
    )))
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
          lastUnreadSeq: scope.lastUnreadSeq,
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
          channelName: parent.name,
          type: parent.type === "forum" ? "forum" : "text",
          lastMessageAt: parent.lastMessageAt ?? "",
          mentionCount: 0,
          hasDirectUnread: false,
          children: [],
        }
        parentRow.children.push({
          channelId: channel.id,
          channelName: channel.name,
          type: "thread",
          lastMessageAt: channel.lastMessageAt ?? "",
          lastUnreadSeq: scope.lastUnreadSeq,
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
        channelName: channel.name,
        type: channel.type === "forum" ? "forum" : "text",
        lastMessageAt: channel.lastMessageAt ?? "",
        lastUnreadSeq: scope.lastUnreadSeq,
        mentionCount: scope.attentionCount,
        hasDirectUnread: scope.attentionCount > 0 || (
          scope.ordinaryUnread && !forumParentScopeIds.has(scope.scopeId)
        ),
        children: previous?.children ?? [],
      })
    }

    for (const item of query.items) {
      if (
        item.kind !== "forum_post"
        || !item.scopeId
        || !item.childChannelId
        || item.openerSeq === undefined
        || !item.messageId
      ) continue
      const scope = scopesById.get(item.scopeId)
      const parent = scope ? channelsById.get(scope.channelId) : undefined
      const child = channelsById.get(item.childChannelId)
      const opener = messagesById?.get(item.messageId)
      if (!scope?.serverId || !parent || !child || !opener) continue
      const serverChannels = grouped.get(scope.serverId) ?? new Map<string, ProjectedUnreadChannel>()
      grouped.set(scope.serverId, serverChannels)
      const parentRow = serverChannels.get(parent.id) ?? {
        channelId: parent.id,
        channelName: parent.name,
        type: "forum",
        lastMessageAt: parent.lastMessageAt ?? "",
        mentionCount: scope.attentionCount,
        hasDirectUnread: scope.ordinaryUnread,
        children: [],
      }
      const existingIndex = parentRow.children.findIndex((row) => row.channelId === child.id)
      const childRow = {
        channelId: child.id,
        channelName: opener.content?.trim() || child.name,
        type: "thread" as const,
        lastMessageAt: opener.createdAt ?? child.lastMessageAt ?? "",
        lastUnreadSeq: item.openerSeq,
        mentionCount: 0,
        parentChannelId: parent.id,
        openerMessageId: item.messageId,
        openerSeq: item.openerSeq,
        openerUnread: true,
      }
      if (existingIndex >= 0) parentRow.children[existingIndex] = childRow
      else parentRow.children.push(childRow)
      serverChannels.set(parent.id, parentRow)
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
      return [{ serverId, serverName: server.name, channels }]
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
        channel: channel.name,
        channelId: channel.id,
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
    const exactAttentionCount = conversations.size + friendRequests.length

    const inputs = [viewEvidence(query.scopes), viewEvidence(query.items), ...query.scopes.flatMap(scope => [viewEvidence(channelsById.get(scope.channelId)), viewEvidence(serversById.get(scope.serverId ?? ""))]), ...mentions.map(row => viewEvidence(messagesById?.get(row.m.id)))]
    for (const values of [servers, dms, mentions, friendRequests]) deriveView(values, inputs, values.length)
    return deriveView({ servers, dms, mentions, friendRequests, exactAttentionCount }, inputs, exactAttentionCount)
  }, [
    channelsById,
    dmProjection,
    messagesById,
    profilesById,
    query.items,
    query.scopes,
    serversById,
  ])

  return {
    ...query,
    ...projected,
    pendingChannelIds: [] as string[],
    isProjectionPending: false,
    hasUnread: projected.servers.length > 0 || projected.dms.length > 0,
    hasMention: projected.mentions.length > 0,
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

type MarkedResponse = { marked: Marked[] }
type MarkedWindowResponse = { marked: Array<Omit<Marked, "m"> & { m: Pick<Marked["m"], "id"> }> }

const inboxMarkedQueryFn = (queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
    const data = throwIfStale(await apiFetchCommunity<MarkedResponse & { stale?: boolean }>(
      "/api/community/users/me/marks",
      signal ? { signal } : undefined, publicationToken,
    ))
    {
      publishCommunityEmbeddedMessages(queryClient, {
        entries: data.marked.map((marked) => ({
          channelId: marked.channelId,
          message: marked.m,
        })),
        proof: { token: publicationToken, signal },
      })
    }
    return { marked: data.marked.map((row) => ({ ...row, m: { id: row.m.id } })) }
  }

export function useInboxMarked(enabled: boolean): UseQueryResult<MarkedWindowResponse> & {
  marked: Marked[]
} {
  const queryClient = useQueryClient()
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const query = useQuery({
    queryKey: communityKeys.inboxMarked(),
    queryFn: inboxMarkedQueryFn(queryClient),
    placeholderData: keepPreviousData,
    enabled,
  })
  const messageIds = useMemo(() => query.data?.marked.map((row) => row.m.id) ?? [], [query.data?.marked])
  const canonicalMessages = useCanonicalMessagesById(messageIds)
  const pendingMarks = useMutationState({ filters: { mutationKey: ["community", "mark-command"], status: "pending" }, select: (mutation) => ({ messageId: (mutation.state.variables as { messageId: string }).messageId, marked: mutation.options.mutationKey?.[2] === true }) })
  const markedAccess = useSelector(unreadProjection.state, (state) => (query.data?.marked ?? []).map((row) => accountUnreadAllowsAccess(state, row)), { compare: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]) })
  const marked = useMemo(() => {
    const source = query.data?.marked ?? (EMPTY_MARKED as Marked[])
    return source.flatMap((marked, index) => {
      if (pendingMarks.filter((command) => command.messageId === marked.m.id).at(-1)?.marked === false) return []
      if (!markedAccess[index]) return []
      const message = materializeCanonicalMessage(marked.m, canonicalMessages)
      return message ? [{ ...marked, m: message }] : []
    })
  }, [canonicalMessages, query.data?.marked, markedAccess, pendingMarks])
  deriveView(marked, [valueEvidence(queryClient, query.data), ...marked.map(row => viewEvidence(row.m))], marked.length)
  return { ...query, marked }
}

export type MessageMarkedResponse = { marked: boolean }

const messageMarkedQueryFn = (messageId: string) => ({ client, signal }: QueryFunctionContext) =>
  apiFetch<MessageMarkedResponse & { stale?: boolean }>(
    `/api/community/messages/${messageId}/marks`, communityRequestOptions(client, signal),
  ).then(throwIfStale)

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
