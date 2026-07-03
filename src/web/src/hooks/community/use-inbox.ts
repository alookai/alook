"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { ForYouEvent, UnreadServer, Mention } from "@/components/community/_types"

// Frozen empty fallbacks — see `use-servers.ts` for the rationale.
const EMPTY_FORYOU: readonly ForYouEvent[] = Object.freeze([])
const EMPTY_UNREADS: readonly UnreadServer[] = Object.freeze([])
const EMPTY_MENTIONS: readonly Mention[] = Object.freeze([])

/**
 * The inbox popover shows three sibling feeds. Each has its own endpoint and
 * its own query key nested under `communityKeys.inbox()` so a single
 * `invalidateQueries({ queryKey: communityKeys.inbox() })` — the WS-side
 * pattern for cross-slice reconciliation — refreshes all three in one batch.
 *
 * Rules the plan pins on this prefix (Step 3 depends on it):
 * - `communityKeys.inboxForYou()`, `communityKeys.inboxUnreads()`, and
 *   `communityKeys.inboxMentions()` all extend `communityKeys.inbox()`.
 * - The hooks stay separate so consumers subscribe granularly (one feed's
 *   refresh doesn't re-render another).
 */

export type ForYouResponse = { events: ForYouEvent[]; limit?: number }

export const inboxForYouQueryFn = () =>
  apiFetch<ForYouResponse>("/api/community/inbox/foryou")

export function useInboxForYou(): UseQueryResult<ForYouResponse> & {
  events: ForYouEvent[]
} {
  const query = useQuery({
    queryKey: communityKeys.inboxForYou(),
    queryFn: inboxForYouQueryFn,
  })
  return {
    ...query,
    events: query.data?.events ?? (EMPTY_FORYOU as ForYouEvent[]),
  }
}

export type UnreadsResponse = { servers: UnreadServer[] }

export const inboxUnreadsQueryFn = () =>
  apiFetch<UnreadsResponse>("/api/community/inbox/unreads")

export function useInboxUnreads(): UseQueryResult<UnreadsResponse> & {
  servers: UnreadServer[]
} {
  const query = useQuery({
    queryKey: communityKeys.inboxUnreads(),
    queryFn: inboxUnreadsQueryFn,
  })
  return {
    ...query,
    servers: query.data?.servers ?? (EMPTY_UNREADS as UnreadServer[]),
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
