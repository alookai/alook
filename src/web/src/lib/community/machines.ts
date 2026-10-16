import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import {
  assertCommunityLiveSnapshotTokenCurrent,
  captureCommunityLiveSnapshotToken,
  communityRequestOptions,
} from "@/lib/community-db/sync"
import type { CommunityMachineSummary, MachineCapacitySummary, ProviderQuotaObservation, QuotaLimit } from "@alook/shared"

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

export type MachineSummary = Omit<CommunityMachineSummary, "status" | "lastSeenAt" | "availableRuntimes" | "lastRuntimeError"> & Partial<Pick<CommunityMachineSummary, "status" | "lastSeenAt" | "availableRuntimes" | "lastRuntimeError">> & {
  quota?: MachineBackendQuota[]
}

export type MachineObservations = { machineCapacity?: MachineCapacitySummary; quotas: Array<{ machineId: string; quota: MachineBackendQuota[] }> }

export type MachinesResponse = { machines: MachineSummary[]; machineCapacity?: MachineCapacitySummary; complete?: boolean; observed?: boolean; source?: "network" | "rsc" | "restored_idb" }

export const machinesOptions = () => queryOptions<MachinesResponse>({
  queryKey: communityKeys.machines(),
  queryFn: async ({ client, signal }) => ({ ...await apiFetch<MachinesResponse>(
    "/api/community/machines?view=list",
    communityRequestOptions(client, signal),
  ), source: "network" as const }),
  staleTime: (query) => query.state.data?.complete === false || query.state.data?.observed === false ? 0 : 5_000,
})

export function captureMachinesPublication(client: QueryClient) {
  return {
    token: captureCommunityLiveSnapshotToken(client),
    query: client.getQueryCache().build<unknown, Error, unknown>(client, { queryKey: communityKeys.machines() }),
  }
}

export function publishMachines(
  client: QueryClient,
  original: ReturnType<typeof captureMachinesPublication>,
  update: (previous: MachinesResponse | undefined) => MachinesResponse | undefined,
) {
  const cancellation = original.query.cancel({ revert: false })
  return client.getMutationCache().build(client, {
    mutationKey: [...communityKeys.machines(), "publication"],
    scope: { id: "community-machine-publication" },
    networkMode: "always",
    gcTime: 0,
    retry: false,
    meta: { observabilityDelegate: true },
    mutationFn: async () => {
      await cancellation
      if (original.query.state.fetchStatus !== "idle") await original.query.cancel({ revert: false })
      assertCommunityLiveSnapshotTokenCurrent(client, original.token, undefined)
      if (client.getQueryCache().get(original.query.queryHash) !== original.query) return false
      client.setQueryData<MachinesResponse>(original.query.queryKey, update)
      void client.invalidateQueries({ queryKey: machineObservationsOptions().queryKey, exact: true })
      return true
    },
  }).execute(undefined)
}

export const machineObservationsOptions = () => queryOptions<MachineObservations>({
  queryKey: [...communityKeys.machines(), "observations"],
  queryFn: ({ client, signal }) => apiFetch("/api/community/machines?view=observations", communityRequestOptions(client, signal)),
  staleTime: 5_000,
})
