"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { UnreadServer, UnreadDm, Mention } from "@/components/community/_types"

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_UNREADS: readonly UnreadServer[] = Object.freeze([])
const EMPTY_DMS: readonly UnreadDm[] = Object.freeze([])
const EMPTY_MENTIONS: readonly Mention[] = Object.freeze([])

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

export const inboxUnreadsQueryFn = () =>
  apiFetch<UnreadsResponse>("/api/community/inbox/unreads")

export function useInboxUnreads(): UseQueryResult<UnreadsResponse> & {
  servers: UnreadServer[]
  dms: UnreadDm[]
} {
  const query = useQuery({
    queryKey: communityKeys.inboxUnreads(),
    queryFn: inboxUnreadsQueryFn,
  })
  return {
    ...query,
    servers: query.data?.servers ?? (EMPTY_UNREADS as UnreadServer[]),
    dms: query.data?.dms ?? (EMPTY_DMS as UnreadDm[]),
  }
}

export type MentionsResponse = { mentions: Mention[] }

export const inboxMentionsQueryFn = () =>
  apiFetch<MentionsResponse>("/api/community/inbox/mentions")

export function useInboxMentions(): UseQueryResult<MentionsResponse> & {
  mentions: Mention[]
} {
  const query = useQuery({
    queryKey: communityKeys.inboxMentions(),
    queryFn: inboxMentionsQueryFn,
  })
  return {
    ...query,
    mentions: query.data?.mentions ?? (EMPTY_MENTIONS as Mention[]),
  }
}
