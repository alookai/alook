"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityMachineSummary } from "@alook/shared"

/**
 * Fetches the current user's community-daemon machines.
 *
 * Replaces the `loadMachines` flow from the community God-context. Step 3 will
 * live-patch `communityKeys.machines()` via `queryClient.setQueryData` on
 * `community:machine.*` WS events, so this list stays fresh without a refetch.
 */
export type MachinesResponse = { machines: CommunityMachineSummary[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_MACHINES: readonly CommunityMachineSummary[] = Object.freeze([])

export const machinesQueryFn = () =>
  apiFetch<MachinesResponse>("/api/community/machines")

export function useMachines(): UseQueryResult<MachinesResponse> & {
  machines: CommunityMachineSummary[]
} {
  const query = useQuery({
    queryKey: communityKeys.machines(),
    queryFn: machinesQueryFn,
  })
  return {
    ...query,
    machines: query.data?.machines ?? (EMPTY_MACHINES as CommunityMachineSummary[]),
  }
}
