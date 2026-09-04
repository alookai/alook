"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQuery, useQueryClient, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadServer, UnreadDm, Mention, Marked } from "@/lib/community/models/inbox"
import {
  inboxMentionRowTarget,
  reserveInboxUnreadsResponse,
} from "./inbox-read-reservation"
import {
  getActiveAccountUnreadProjection,
  type AccountUnreadProjection,
  type AccountUnreadSource,
} from "./account-unread-projection"
import { useInboxProjectionTarget } from "./use-inbox-auto-collapse"
import {
  isInboxTargetReserved,
  reservedUnreadExclusion,
  selectUnreadPresentation,
} from "./unread-presentation"

class StaleReadError extends Error {
  constructor() { super("stale D1 read"); this.name = "StaleReadError" }
}
function throwIfStale<T extends { stale?: boolean }>(v: T): T {
  if (v?.stale) throw new StaleReadError()
  return v
}

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_UNREADS: readonly UnreadServer[] = Object.freeze([])
const EMPTY_DMS: readonly UnreadDm[] = Object.freeze([])
const EMPTY_MENTIONS: readonly Mention[] = Object.freeze([])
const EMPTY_MARKED: readonly Marked[] = Object.freeze([])

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
  servers: UnreadServer[]
  dms: UnreadDm[]
  limit?: number
  truncated?: boolean
}

const inboxUnreadsTransportFn = ({ signal }: { signal?: AbortSignal } = {}) =>
  apiFetchProfiles<UnreadsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/unreads",
    (data) => {
      return data.dms.map((dm) => ({
        id: dm.otherUserId,
        identityAbout: {
          name: dm.otherUserName,
          discriminator: dm.otherUserDiscriminator,
        },
        avatar: {
          avatar: dm.otherUserAvatar,
          avatarVersion: dm.otherUserAvatarVersion,
        },
      }))
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
    const options = { truncated: data.truncated ?? true, stale: data.stale }
    projection.absorbSnapshot(channelsToken, sources.channels, options)
    projection.absorbSnapshot(dmsToken, sources.dms, options)
    throwIfStale(data)
    return reserveInboxUnreadsResponse(queryClient, data, signal)
  } catch (error) {
    projection.cancelSnapshot(channelsToken)
    projection.cancelSnapshot(dmsToken)
    throw error
  }
}

export function useInboxUnreads(): UseQueryResult<UnreadsResponse> & {
  servers: UnreadServer[]
  dms: UnreadDm[]
  hasProjectedUnread: boolean
} {
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
  const reservationTarget = useInboxProjectionTarget(queryClient)
  const channelExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "channels"),
    [reservationTarget],
  )
  const dmExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "dms"),
    [reservationTarget],
  )
  const queryFn = useMemo(
    () => inboxUnreadsProjectedQueryFn(queryClient, unreadProjection),
    [queryClient, unreadProjection],
  )
  const query = useQuery({
    queryKey: communityKeys.inboxUnreads(),
    queryFn,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  useEffect(() => {
    if (!query.data) return
    const sources = inboxUnreadSources(query.data)
    unreadProjection.mergeSources("inbox-unreads", sources.channels, "channels")
    unreadProjection.mergeSources("inbox-unreads", sources.dms, "dms")
    unreadProjection.recordLegacySnapshot(query.data, [
      ...query.data.servers.flatMap((server) => server.channels.flatMap((channel) => [
        ...(channel.lastUnreadSeq === undefined && channel.hasDirectUnread !== false
          ? [{
              family: "inbox-unreads" as const,
              channelId: channel.channelId,
              serverId: server.serverId,
            }]
          : []),
        ...channel.children.flatMap((child) => child.lastUnreadSeq === undefined
          ? [{
              family: "inbox-unreads" as const,
              channelId: child.channelId,
              serverId: server.serverId,
              railChannelId: channel.channelId,
            }]
          : []),
      ])),
      ...query.data.dms.flatMap((dm) => dm.lastUnreadSeq === undefined
        ? [{ family: "inbox-unreads" as const, channelId: dm.channelId }]
        : []),
    ])
  }, [query.data, unreadProjection])
  const projected = useMemo(() => {
    void unreadVersion
    const rawServers = query.data?.servers ?? (EMPTY_UNREADS as UnreadServer[])
    let serversChanged = false
    const servers = rawServers.flatMap((server) => {
      let channelsChanged = false
      const channels = server.channels.flatMap((channel) => {
        const children = channel.children.filter((child) => selectUnreadPresentation({
          accountUnread: unreadProjection.projectUnread(
            "inbox-unreads",
            child.channelId,
            true,
            child.lastUnreadSeq,
            "channels",
            channelExclusion,
          ),
        }).effectiveUnread)
        const direct = channel.hasDirectUnread !== false && selectUnreadPresentation({
          accountUnread: unreadProjection.projectUnread(
            "inbox-unreads",
            channel.channelId,
            true,
            channel.lastUnreadSeq,
            "channels",
            channelExclusion,
          ),
        }).effectiveUnread
        if (!direct && children.length === 0) {
          channelsChanged = true
          return []
        }
        const childrenChanged = children.length !== channel.children.length
        const directChanged = direct !== (channel.hasDirectUnread !== false)
        if (!childrenChanged && !directChanged) return [channel]
        channelsChanged = true
        return [{ ...channel, hasDirectUnread: direct, children }]
      })
      if (channels.length === 0) {
        serversChanged = true
        return []
      }
      if (!channelsChanged) return [server]
      serversChanged = true
      return [{ ...server, channels }]
    })
    const rawDms = query.data?.dms ?? (EMPTY_DMS as UnreadDm[])
    const dms = rawDms.filter((dm) => selectUnreadPresentation({
      accountUnread: unreadProjection.projectUnread(
        "inbox-unreads",
        dm.channelId,
        true,
        dm.lastUnreadSeq,
        "dms",
        dmExclusion,
      ),
    }).effectiveUnread)
    return {
      servers: serversChanged ? servers : rawServers,
      dms: dms.length === rawDms.length ? rawDms : dms,
    }
  }, [channelExclusion, dmExclusion, query.data, unreadProjection, unreadVersion])
  return {
    ...query,
    servers: projected.servers ?? (EMPTY_UNREADS as UnreadServer[]),
    dms: projected.dms ?? (EMPTY_DMS as UnreadDm[]),
    hasProjectedUnread:
      projected.servers.length > 0
      || projected.dms.length > 0
      || unreadProjection.hasPending("inbox-unreads", "channels", channelExclusion)
      || unreadProjection.hasPending("inbox-unreads", "dms", dmExclusion),
  }
}

export type MentionsResponse = {
  mentions: Mention[]
  limit?: number
  truncated?: boolean
}

const inboxMentionsTransportFn = () =>
  apiFetchProfiles<MentionsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/mentions",
    (data) => messageProfilePatches(data.mentions.map((mention) => mention.m)),
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
) => async () => {
  const token = projection.beginSnapshot("inbox-mentions", "mentions")
  try {
    const data = await inboxMentionsTransportFn()
    projection.absorbSnapshot(token, inboxMentionSources(data), {
      truncated: data.truncated ?? true,
      stale: data.stale,
    })
    return throwIfStale(data)
  } catch (error) {
    projection.cancelSnapshot(token)
    throw error
  }
}

export function useInboxMentions(): UseQueryResult<MentionsResponse> & {
  mentions: Mention[]
  hasProjectedMention: boolean
} {
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
  const reservationTarget = useInboxProjectionTarget(queryClient)
  const mentionExclusion = useMemo(
    () => reservedUnreadExclusion(reservationTarget, "channels"),
    [reservationTarget],
  )
  const queryFn = useMemo(
    () => inboxMentionsProjectedQueryFn(unreadProjection),
    [unreadProjection],
  )
  const query = useQuery({
    queryKey: communityKeys.inboxMentions(),
    queryFn,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  useEffect(() => {
    if (!query.data) return
    unreadProjection.mergeSources(
      "inbox-mentions",
      inboxMentionSources(query.data),
      "mentions",
    )
    unreadProjection.recordLegacySnapshot(
      query.data,
      query.data.mentions.flatMap((mention) => (
        mention.channelId && !mention.m.seq
          ? [{
              family: "inbox-mentions" as const,
              channelId: mention.channelId,
              serverId: mention.serverId,
              isMention: true,
            }]
          : []
      )),
    )
  }, [query.data, unreadProjection])
  const mentions = useMemo(() => {
    void unreadVersion
    const raw = query.data?.mentions ?? (EMPTY_MENTIONS as Mention[])
    const projected = raw.filter((mention) => (
      !mention.channelId
      || selectUnreadPresentation({
        accountUnread: unreadProjection.projectUnread(
          "inbox-mentions",
          mention.channelId,
          true,
          mention.m.seq,
          "mentions",
          mentionExclusion,
          true,
          mention.id,
        ),
        reserved: isInboxTargetReserved(
          reservationTarget,
          inboxMentionRowTarget(mention),
        ),
      }).effectiveUnread
    ))
    return projected.length === raw.length ? raw : projected
  }, [mentionExclusion, query.data, reservationTarget, unreadProjection, unreadVersion])
  return {
    ...query,
    mentions,
    hasProjectedMention:
      mentions.length > 0
      || unreadProjection.hasPending(
        "inbox-mentions",
        "mentions",
        mentionExclusion,
      ),
  }
}

export type MarkedResponse = { marked: Marked[] }

const inboxMarkedQueryFn = () =>
  apiFetchProfiles<MarkedResponse & { stale?: boolean }>(
    "/api/community/users/me/marks",
    (data) => {
      throwIfStale(data)
      return messageProfilePatches(data.marked.map((marked) => marked.m))
    },
  )

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
  const query = useQuery({
    queryKey: communityKeys.inboxMarked(),
    queryFn: inboxMarkedQueryFn,
    placeholderData: keepPreviousData,
    enabled,
  })
  return {
    ...query,
    marked: query.data?.marked ?? (EMPTY_MARKED as Marked[]),
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
