"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { DM } from "@/components/community/_types"

/**
 * Fetches the DM conversation sidebar list.
 *
 * The `Presence` field in each DM is a placeholder "offline" — the actual
 * live badge is layered on later from the WS presence store in the consumer.
 * Step 3 will invalidate this key on `community:dm.new_message` events.
 */
export type DmsResponse = { conversations: DM[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_DMS: readonly DM[] = Object.freeze([])

export const dmsQueryFn = () =>
  apiFetch<DmsResponse>("/api/community/dm")

export function useDms(): UseQueryResult<DmsResponse> & { dms: DM[] } {
  const query = useQuery({
    queryKey: communityKeys.dms(),
    queryFn: dmsQueryFn,
  })
  return {
    ...query,
    dms: query.data?.conversations ?? (EMPTY_DMS as DM[]),
  }
}
