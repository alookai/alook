"use client"

import { useMemo, useSyncExternalStore } from "react"
import { useQuery, useQueryClient, keepPreviousData, type QueryClient, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadServer, UnreadDm, InboxFriendRequest, Mention, Marked } from "@/lib/community/models/inbox"
import { reserveInboxUnreadsResponse } from "./inbox-read-reservation"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
  type AccountUnreadSource,
} from "./account-unread-projection"
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
  constructor() { super("stale D1 read"); this.name = "StaleReadError" }
}
function throwIfStale<T extends { stale?: boolean }>(v: T): T {
  if (v?.stale) throw new StaleReadError()
  return v
}

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_MARKED: readonly Marked[] = Object.freeze([])

type ProjectedUnreadChild = UnreadServer["channels"][number]["children"][number] & {
  lastAttentionSeq?: number | null
}

type ProjectedUnreadChannel = Omit<UnreadServer["channels"][number], "children"> & {
  lastAttentionSeq?: number | null
  children: ProjectedUnreadChild[]
}

type ProjectedUnreadServer = Omit<UnreadServer, "channels"> & {
  channels: ProjectedUnreadChannel[]
}

type ProjectedMention = Mention & {
  parentChannelId?: string | null
}

/**
 * The inbox popover shows two sibling feeds. Each has its own endpoint and
 * its own query key nested under `communityKeys.inbox()` so a single
 * `invalidateQueries({ queryKey: communityKeys.inbox() })` — the WS-side
 * pattern for cross-slice reconciliation — refreshes both in one batch.
 *
 * Rules the plan pins on this prefix:
 * - `communityKeys.inboxUnreads()` and `communityKeys.inboxMentions()` both
 *   extend `communityKeys.inbox()`.
 * - The hooks stay separate so consumers subscribe granularly (one feed's
 *   refresh doesn't re-render the other).
 */

export type UnreadsResponse = {
  friendRequests: InboxFriendRequest[]
  servers: ProjectedUnreadServer[]
  dms: UnreadDm[]
  limit?: number
  truncated?: boolean
}

const inboxUnreadsTransportFn = ({ signal }: { signal?: AbortSignal } = {}) =>
  apiFetchProfiles<UnreadsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/unreads",
    (data) => {
      return [
        ...(data.friendRequests ?? []).map((request) => ({
          id: request.userId,
          identityAbout: { name: request.name },
          ...(request.avatarVersion === null ? {} : {
            avatar: {
              avatar: request.avatar,
              avatarVersion: request.avatarVersion,
            },
          }),
        })),
        ...data.dms.map((dm) => ({
          id: dm.otherUserId,
          identityAbout: {
            name: dm.otherUserName,
            discriminator: dm.otherUserDiscriminator,
          },
          avatar: {
            avatar: dm.otherUserAvatar,
            avatarVersion: dm.otherUserAvatarVersion,
          },
        })),
      ]
    },
    { signal },
  )

export const inboxUnreadsQueryFn = async (
  context: { signal?: AbortSignal } = {},
) => throwIfStale(await inboxUnreadsTransportFn(context))

export const inboxUnreadsReservedQueryFn = (queryClient: ReturnType<typeof useQueryClient>) => (
  { signal }: { signal?: AbortSignal } = {},
) => inboxUnreadsQueryFn({ signal }).then(
  (data) => reserveInboxUnreadsResponse(queryClient, data, signal),
)

function inboxUnreadSources(data: UnreadsResponse) {
  const channels: AccountUnreadSource[] = data.servers.flatMap((server) => (
    server.channels.flatMap((channel) => [
      ...(channel.lastUnreadSeq === undefined ? [] : [{
        channelId: channel.channelId,
        serverId: server.serverId,
        lastUnreadSeq: channel.lastUnreadSeq,
      }]),
      ...(channel.lastAttentionSeq === undefined || channel.lastAttentionSeq === null ? [] : [{
        channelId: channel.channelId,
        serverId: server.serverId,
        lastUnreadSeq: channel.lastAttentionSeq,
        lastMentionSeq: channel.lastAttentionSeq,
        isMention: true,
      }]),
      ...channel.children.flatMap((child) => [
        ...(child.lastUnreadSeq === undefined ? [] : [{
          channelId: child.channelId,
          serverId: server.serverId,
          railChannelId: channel.channelId,
          lastUnreadSeq: child.lastUnreadSeq,
        }]),
        ...(child.lastAttentionSeq === undefined || child.lastAttentionSeq === null ? [] : [{
          channelId: child.channelId,
          serverId: server.serverId,
          railChannelId: channel.channelId,
          lastUnreadSeq: child.lastAttentionSeq,
          lastMentionSeq: child.lastAttentionSeq,
          isMention: true,
        }]),
      ]),
    ])
  ))
  const dms: AccountUnreadSource[] = data.dms.flatMap((dm) => (
    dm.lastUnreadSeq === undefined ? [] : [{
      channelId: dm.channelId,
      lastUnreadSeq: dm.lastUnreadSeq,
    }]
  ))
  return { channels, dms }
}

export const inboxUnreadsProjectedQueryFn = (
  queryClient: ReturnType<typeof useQueryClient>,
  projection: AccountUnreadProjection,
) => async ({ signal }: { signal?: AbortSignal } = {}) => {
  const channelsToken = projection.beginSnapshot("inbox-unreads", "channels")
  const dmsToken = projection.beginSnapshot("inbox-unreads", "dms")
  try {
    const data = await inboxUnreadsTransportFn({ signal })
    const sources = inboxUnreadSources(data)
    projection.absorbSnapshot(channelsToken, sources.channels, {
      truncated: data.truncated ?? true,
      stale: data.stale,
    })
    // The route's cap and `truncated` bit cover server nodes only. DMs are
    // always returned as a complete, independently authoritative domain.
    projection.absorbSnapshot(dmsToken, sources.dms, {
      truncated: false,
      stale: data.stale,
    })
    throwIfStale(data)
    return reserveInboxUnreadsResponse(queryClient, data, signal)
  } catch (error) {
    projection.cancelSnapshot(channelsToken)
    projection.cancelSnapshot(dmsToken)
    throw error
  }
}

export function useInboxUnreads() {
  const query = useAccountAttentionProjection()
  const channelsById = useCanonicalChannelsById()
  const serversById = useCanonicalServersById()
  const profilesById = useCanonicalProfilesByUserId()
  const dmProjection = useDmProjection()
  const projected = useMemo(() => {
    const pendingChannelIds: string[] = []
    const dmById = new Map((dmProjection ?? []).map((dm) => [dm.id, dm]))
    const dms: UnreadDm[] = []
    const grouped = new Map<string, Map<string, ProjectedUnreadChannel>>()
    for (const scope of query.scopes) {
      if (!scope.ordinaryUnread && scope.attentionCount <= 0) continue
      const channel = channelsById.get(scope.channelId)
      if (!channel) {
        pendingChannelIds.push(scope.channelId)
        continue
      }
      if (!scope.serverId) {
        const dm = dmById.get(scope.channelId)
        if (!dm) {
          pendingChannelIds.push(scope.channelId)
          continue
        }
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
      const serverChannels = grouped.get(scope.serverId) ?? new Map<string, ProjectedUnreadChannel>()
      grouped.set(scope.serverId, serverChannels)
      if (scope.parentChannelId) {
        const parent = channelsById.get(scope.parentChannelId)
        if (!parent) {
          pendingChannelIds.push(scope.channelId)
          continue
        }
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
          lastAttentionSeq: scope.lastAttentionSeq,
          mentionCount: scope.attentionCount,
          parentChannelId: parent.id,
          ...(channel.parentMessageId ? { openerMessageId: channel.parentMessageId } : {}),
        })
        serverChannels.set(parent.id, parentRow)
        continue
      }
      serverChannels.set(channel.id, {
        channelId: channel.id,
        channelName: channel.name,
        type: channel.type === "forum" ? "forum" : "text",
        lastMessageAt: channel.lastMessageAt ?? "",
        lastUnreadSeq: scope.lastUnreadSeq,
        lastAttentionSeq: scope.lastAttentionSeq,
        mentionCount: scope.attentionCount,
        hasDirectUnread: scope.ordinaryUnread,
        children: serverChannels.get(channel.id)?.children ?? [],
      })
    }

    const servers: UnreadServer[] = [...grouped].flatMap(([serverId, rows]) => {
      const server = serversById.get(serverId)
      if (!server) {
        pendingChannelIds.push(...[...rows.values()].map((row) => row.channelId))
        return []
      }
      return [{
        serverId,
        serverName: server.name,
        channels: [...rows.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)),
      }]
    })
    const friendRequests: InboxFriendRequest[] = query.items
      .filter((item) => item.kind === "friend_request")
      .map((item) => {
        const profile = profilesById.get(item.actorUserId)
        return {
          id: item.sourceId,
          userId: item.actorUserId,
          name: profile?.name ?? "Deleted user",
          avatar: profile?.avatar ?? "",
          avatarVersion: profile?.avatarVersion ?? null,
          createdAt: item.createdAt,
          pendingIdentity: !profile,
        }
      })
    return { servers, dms, friendRequests, pendingChannelIds }
  }, [channelsById, dmProjection, profilesById, query.items, query.scopes, serversById])
  return {
    ...query,
    friendRequests: projected.friendRequests,
    servers: projected.servers,
    dms: projected.dms,
    pendingChannelIds: projected.pendingChannelIds,
    isProjectionPending: projected.pendingChannelIds.length > 0,
    hasProjectedUnread: projected.servers.length > 0
      || projected.dms.length > 0
      || projected.pendingChannelIds.length > 0,
    hasOutstandingFriendRequest: projected.friendRequests.length > 0,
    exactAttentionCount: query.scopes.reduce((total, scope) => total + scope.attentionCount, 0),
  }
}

export type MentionsResponse = {
  mentions: ProjectedMention[]
  limit?: number
  truncated?: boolean
}

const inboxMentionsTransportFn = (signal?: AbortSignal) =>
  apiFetchProfiles<MentionsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/mentions",
    (data) => messageProfilePatches(data.mentions.map((mention) => mention.m)),
    signal ? { signal } : undefined,
  )

export const inboxMentionsQueryFn = async () => (
  throwIfStale(await inboxMentionsTransportFn())
)

function inboxMentionSources(data: MentionsResponse): AccountUnreadSource[] {
  return data.mentions.flatMap((mention) => (
    mention.channelId && mention.m.seq
      ? [{
          channelId: mention.channelId,
          serverId: mention.serverId,
          railChannelId: mention.parentChannelId ?? undefined,
          messageId: mention.m.id,
          attentionId: mention.id,
          lastUnreadSeq: mention.m.seq,
          lastMentionSeq: mention.m.seq,
        }]
      : []
  ))
}

export const inboxMentionsProjectedQueryFn = (
  projection: AccountUnreadProjection,
  queryClient?: QueryClient,
) => async ({ signal }: { signal?: AbortSignal } = {}) => {
  const token = projection.beginSnapshot("inbox-mentions", "mentions")
  const publicationToken = queryClient
    ? captureCommunityLiveSnapshotToken(queryClient)
    : null
  try {
    const data = throwIfStale(await inboxMentionsTransportFn(signal))
    if (queryClient && publicationToken) {
      publishCommunityEmbeddedMessages(queryClient, {
        entries: data.mentions.flatMap((mention) => mention.channelId
          ? [{ channelId: mention.channelId, message: mention.m }]
          : []),
        proof: { token: publicationToken, signal },
      })
    }
    projection.absorbSnapshot(token, inboxMentionSources(data), {
      truncated: data.truncated ?? true,
      stale: data.stale,
    })
    return data
  } catch (error) {
    projection.cancelSnapshot(token)
    throw error
  }
}

export function useInboxMentions() {
  const canonicalMessages = useCanonicalMessagesById()
  const channelsById = useCanonicalChannelsById()
  const serversById = useCanonicalServersById()
  const query = useAccountAttentionProjection()
  const projected = useMemo(() => {
    const pendingChannelIds: string[] = []
    const scopesById = new Map(query.scopes.map((scope) => [scope.scopeId, scope]))
    const mentions = query.items.flatMap((item): Mention[] => {
      if (item.kind === "friend_request" || !item.scopeId || !item.messageId) return []
      if (item.kind === "pending") {
        pendingChannelIds.push(item.scopeId)
        return []
      }
      const scope = scopesById.get(item.scopeId)
      const message = canonicalMessages?.get(item.messageId)
      const channel = scope ? channelsById.get(scope.channelId) : undefined
      if (!scope || !message || !channel) {
        pendingChannelIds.push(scope?.channelId ?? item.scopeId)
        return [{
          id: item.sourceId,
          kind: item.kind,
          server: "",
          ...(scope?.serverId ? { serverId: scope.serverId } : {}),
          channel: "",
          channelId: scope?.channelId ?? item.scopeId,
          pending: true,
          m: {
            id: item.messageId,
            type: "chat",
            authorId: item.actorUserId,
          },
        }]
      }
      return [{
        id: item.sourceId,
        kind: item.kind,
        server: scope.serverId
          ? serversById.get(scope.serverId)?.name ?? "Server unavailable"
          : "Conversation unavailable",
        ...(scope.serverId ? { serverId: scope.serverId } : {}),
        channel: channel.name || "Conversation unavailable",
        channelId: channel.id,
        m: message,
      }]
    })
    return { mentions, pendingChannelIds }
  }, [canonicalMessages, channelsById, query.items, query.scopes, serversById])
  return {
    ...query,
    mentions: projected.mentions,
    pendingChannelIds: projected.pendingChannelIds,
    isProjectionPending: projected.pendingChannelIds.length > 0,
    hasProjectedMention: projected.mentions.length > 0 || projected.pendingChannelIds.length > 0,
  }
}

export type MarkedResponse = { marked: Marked[] }

const inboxMarkedQueryFn = (queryClient: QueryClient) =>
  async ({ signal }: { signal?: AbortSignal } = {}) => {
    const publicationToken = captureCommunityLiveSnapshotToken(queryClient)
    const data = await apiFetchProfiles<MarkedResponse & { stale?: boolean }>(
      "/api/community/users/me/marks",
      (response) => {
        throwIfStale(response)
        return messageProfilePatches(response.marked.map((marked) => marked.m))
      },
      signal ? { signal } : undefined,
    )
    if (publicationToken) {
      publishCommunityEmbeddedMessages(queryClient, {
        entries: data.marked.map((marked) => ({
          channelId: marked.channelId,
          message: marked.m,
        })),
        proof: { token: publicationToken, signal },
      })
    }
    return throwIfStale(data)
  }

/**
 * The Marked feed is lazy — unlike unreads/mentions (which the shell reads
 * eagerly to drive the bell badge), the Marked tab has no badge and only
 * matters once the viewer opens it. Pass `enabled` = "is the Marked tab
 * selected" so the fetch is deferred until then, per the plan's
 * enabled-gate lazy-load.
 */
export function useInboxMarked(enabled: boolean): UseQueryResult<MarkedResponse> & {
  marked: Marked[]
} {
  const canonicalMessages = useCanonicalMessagesById()
  const queryClient = useQueryClient()
  const unreadProjection = useMemo(
    () => getActiveAccountUnreadProjection(queryClient),
    [queryClient],
  )
  const unreadVersion = useSyncExternalStore(
    unreadProjection.subscribe,
    unreadProjection.getSnapshot,
    unreadProjection.getSnapshot,
  )
  const query = useQuery({
    queryKey: communityKeys.inboxMarked(),
    queryFn: inboxMarkedQueryFn(queryClient),
    placeholderData: keepPreviousData,
    enabled,
  })
  const marked = useMemo(() => {
    void unreadVersion
    const source = query.data?.marked ?? (EMPTY_MARKED as Marked[])
    return source.flatMap((marked) => {
      if (!unreadProjection.allowsAccess({
        channelId: marked.channelId,
        serverId: marked.serverId,
      })) return []
      const message = materializeCanonicalMessage(marked.m, canonicalMessages)
      return message ? [{ ...marked, m: message }] : []
    })
  }, [canonicalMessages, query.data?.marked, unreadProjection, unreadVersion])
  return {
    ...query,
    marked,
  }
}

export type MessageMarkedResponse = { marked: boolean }

const messageMarkedQueryFn = (messageId: string) => () =>
  apiFetch<MessageMarkedResponse & { stale?: boolean }>(
    `/api/community/messages/${messageId}/marks`,
  ).then(throwIfStale)

/**
 * Whether the viewer has marked one message — fetched lazily when its ⋯ menu
 * opens (`enabled` = menu-open) so a channel never pre-loads mark state for
 * every row. Single indexed row read; the result is cached per message id so
 * re-opening the same menu doesn't re-query. Drives the Mark/Unmark label —
 * the menu renders "Mark" first and silently flips to "Unmark" if this
 * resolves marked (no spinner, per Alli).
 */
export function useMessageMarked(messageId: string, enabled: boolean): UseQueryResult<MessageMarkedResponse> {
  return useQuery({
    queryKey: communityKeys.messageMarked(messageId),
    queryFn: messageMarkedQueryFn(messageId),
    enabled,
    staleTime: 30_000,
  })
}
