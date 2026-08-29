"use client"

import { useMemo } from "react"
import { useQuery, useQueryClient, keepPreviousData, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { apiFetchProfiles, messageProfilePatches } from "@/lib/community/profile-seed"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadServer, UnreadDm, Mention, Marked } from "@/lib/community/models/inbox"
import { reserveInboxUnreadsResponse } from "./inbox-read-reservation"

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

export type UnreadsResponse = { servers: UnreadServer[]; dms: UnreadDm[] }

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
} {
  const queryClient = useQueryClient()
  const queryFn = useMemo(() => inboxUnreadsReservedQueryFn(queryClient), [queryClient])
  const query = useQuery({
    queryKey: communityKeys.inboxUnreads(),
    queryFn,
    placeholderData: keepPreviousData,
  })
  return {
    ...query,
    servers: query.data?.servers ?? (EMPTY_UNREADS as UnreadServer[]),
    dms: query.data?.dms ?? (EMPTY_DMS as UnreadDm[]),
  }
}

export type MentionsResponse = { mentions: Mention[] }

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
} {
  const query = useQuery({
    queryKey: communityKeys.inboxMentions(),
    queryFn: inboxMentionsQueryFn,
    placeholderData: keepPreviousData,
  })
  return {
    ...query,
    mentions: query.data?.mentions ?? (EMPTY_MENTIONS as Mention[]),
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
