"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQuery, useQueryClient, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadServer, UnreadDm, Mention, Marked } from "@/lib/community/models/inbox"
import { reserveInboxUnreadsResponse } from "./inbox-read-reservation"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"

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

export const inboxUnreadsQueryFn = ({ signal }: { signal?: AbortSignal } = {}) =>
  apiFetchProfiles<UnreadsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/unreads",
    (data) => {
      throwIfStale(data)
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

export const inboxUnreadsReservedQueryFn = (queryClient: ReturnType<typeof useQueryClient>) => (
  { signal }: { signal?: AbortSignal } = {},
) => inboxUnreadsQueryFn({ signal }).then(
  (data) => reserveInboxUnreadsResponse(queryClient, data, signal),
)

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
  const queryFn = useMemo(() => inboxUnreadsReservedQueryFn(queryClient), [queryClient])
  const query = useQuery({
    queryKey: communityKeys.inboxUnreads(),
    queryFn,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  useEffect(() => {
    if (!query.data) return
    const channelSources = query.data.servers.flatMap((server) => server.channels.flatMap((channel) => [
      ...(channel.lastUnreadSeq === undefined ? [] : [{
        channelId: channel.channelId,
        lastUnreadSeq: channel.lastUnreadSeq,
      }]),
      ...channel.children.flatMap((child) => child.lastUnreadSeq === undefined ? [] : [{
        channelId: child.channelId,
        lastUnreadSeq: child.lastUnreadSeq,
      }]),
    ]))
    const dmSources = query.data.dms.flatMap((dm) => dm.lastUnreadSeq === undefined ? [] : [{
      channelId: dm.channelId,
      lastUnreadSeq: dm.lastUnreadSeq,
    }])
    unreadProjection.absorbFamily("inbox-unreads", channelSources, {
      truncated: query.data.truncated ?? true,
      domain: "channels",
    })
    unreadProjection.absorbFamily("inbox-unreads", dmSources, {
      truncated: false,
      domain: "dms",
    })
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
        const children = channel.children.filter((child) => unreadProjection.projectUnread(
          "inbox-unreads",
          child.channelId,
          true,
          child.lastUnreadSeq,
        ))
        const direct = channel.hasDirectUnread !== false && unreadProjection.projectUnread(
          "inbox-unreads",
          channel.channelId,
          true,
          channel.lastUnreadSeq,
        )
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
    const dms = rawDms.filter((dm) => unreadProjection.projectUnread(
      "inbox-unreads",
      dm.channelId,
      true,
      dm.lastUnreadSeq,
      "dms",
    ))
    return {
      servers: serversChanged ? servers : rawServers,
      dms: dms.length === rawDms.length ? rawDms : dms,
    }
  }, [query.data, unreadProjection, unreadVersion])
  return {
    ...query,
    servers: projected.servers ?? (EMPTY_UNREADS as UnreadServer[]),
    dms: projected.dms ?? (EMPTY_DMS as UnreadDm[]),
    hasProjectedUnread:
      projected.servers.length > 0
      || projected.dms.length > 0
      || unreadProjection.hasPending("inbox-unreads", "channels")
      || unreadProjection.hasPending("inbox-unreads", "dms"),
  }
}

export type MentionsResponse = {
  mentions: Mention[]
  limit?: number
  truncated?: boolean
}

export const inboxMentionsQueryFn = () =>
  apiFetchProfiles<MentionsResponse & { stale?: boolean }>(
    "/api/community/users/me/inbox/mentions",
    (data) => {
      throwIfStale(data)
      return messageProfilePatches(data.mentions.map((mention) => mention.m))
    },
  )

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
  const query = useQuery({
    queryKey: communityKeys.inboxMentions(),
    queryFn: inboxMentionsQueryFn,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnReconnect: true,
  })
  useEffect(() => {
    if (!query.data) return
    unreadProjection.absorbFamily(
      "inbox-mentions",
      query.data.mentions.flatMap((mention) => (
        mention.channelId && mention.m.seq
          ? [{
              channelId: mention.channelId,
              lastUnreadSeq: mention.m.seq,
              lastMentionSeq: mention.m.seq,
            }]
          : []
      )),
      { truncated: query.data.truncated ?? true },
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
      || unreadProjection.projectUnread(
        "inbox-mentions",
        mention.channelId,
        true,
        mention.m.seq,
      )
    ))
    return projected.length === raw.length ? raw : projected
  }, [query.data, unreadProjection, unreadVersion])
  return {
    ...query,
    mentions,
    hasProjectedMention:
      mentions.length > 0 || unreadProjection.hasPending("inbox-mentions", "mentions"),
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
