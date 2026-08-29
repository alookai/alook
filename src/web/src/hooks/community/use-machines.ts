"use client"

import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import type {
  CommunityMachineSummary,
  ProviderQuotaObservation,
  QuotaLimit,
} from "@alook/shared"

type MachineQuotaSnapshot =
  | { status: "pending" }
  | {
      status: "error"
      code: Extract<ProviderQuotaObservation, { status: "error" }>["code"]
    }
  | {
      status: "available" | "stale"
      observedAt: string
      planName?: string
      limits: QuotaLimit[]
    }

export type MachineBackendQuota = {
  scope: {
    kind: "machine_backend"
    machineId: string
    agentBackendId: string
  }
  capability: "supported" | "unsupported" | "unknown"
  runtimeState: "healthy" | "unhealthy" | "offline"
  snapshot: MachineQuotaSnapshot
}

// Machine WS events intentionally carry the base summary without owner-only
// quota. Keep quota optional so live status updates can replace a machine safely;
// the next owner API fetch restores its complete replace-all quota snapshot.
export type MachineSummary = CommunityMachineSummary & {
  quota?: MachineBackendQuota[]
}

/**
 * Fetches the current user's community-daemon machines.
 *
 * Replaces the `loadMachines` flow from the community God-context. Step 3 will
 * live-patch `communityKeys.machines()` via `queryClient.setQueryData` on
 * `community:machine.*` WS events, so this list stays fresh without a refetch.
 */
export type MachinesResponse = { machines: MachineSummary[] }

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_MACHINES: readonly MachineSummary[] = Object.freeze([])

export const machinesQueryFn = () =>
  apiFetch<MachinesResponse>("/api/community/machines")

export function useMachines(): UseQueryResult<MachinesResponse> & {
  machines: MachineSummary[]
} {
  const query = useQuery({
    queryKey: communityKeys.machines(),
    queryFn: machinesQueryFn,
  })
  return {
    ...query,
    machines: query.data?.machines ?? (EMPTY_MACHINES as MachineSummary[]),
  }
}
