import { visibleRuntimes } from "./runtime-label"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { queryOptions, type QueryClient } from "@tanstack/react-query"
import { CommunityResourceError } from "@/lib/errors"
import { apiFetch } from "@/lib/api/client"
import { communityKeys } from "@/lib/query-keys"
import { assertCommunityLiveSnapshotTokenCurrent, captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { isPresenceOnline, type CommunityMachineRuntime, CommunityMachineListReadSchema, type CommunityMachineIdentityCache, type CommunityMachineSummary, type MachineCapacitySummary, type ProviderQuotaObservation, type QuotaLimit } from "@alook/shared"

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

export type MachineSummary = CommunityMachineIdentityCache & Partial<Pick<CommunityMachineSummary, "status" | "lastSeenAt" | "availableRuntimes" | "lastRuntimeError">> & {
  quota?: MachineBackendQuota[]
}

export type MachineObservations = { machineCapacity?: MachineCapacitySummary; quotas: Array<{ machineId: string; quota: MachineBackendQuota[] }> }

export type MachinesResponse = { machines: MachineSummary[]; machineCapacity?: MachineCapacitySummary; complete: boolean; observed?: boolean; source?: "network" | "rsc" | "restored_idb" }

export const machinesOptions = () => queryOptions<MachinesResponse>({
  queryKey: communityKeys.machines(),
  queryFn: async ({ client, signal }) => {
    const parsed = CommunityMachineListReadSchema.safeParse(await apiFetch<unknown>("/api/community/machines?view=list", communityRequestOptions(client, captureCommunityLiveSnapshotToken(client), signal)))
    if (!parsed.success) throw new CommunityResourceError(parsed.error)
    return { ...parsed.data, observed: true, source: "network" as const }
  },
  staleTime: (query) => query.state.data?.complete !== true || query.state.data?.observed !== true ? 0 : 5_000,
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
  queryFn: ({ client, signal }) => apiFetch("/api/community/machines?view=observations", communityRequestOptions(client, captureCommunityLiveSnapshotToken(client), signal)),
  staleTime: 5_000,
})

export type BotRuntimeOption = Pick<CommunityMachineRuntime, "id" | "reasoning"> & {
  unhealthy: boolean
}

// Persisted caches can contain missing runtimes or bare string entries.
// Keep unhealthy options visible so the picker can explain their disabled state.
export function normalizeRuntimes(machine: MachineSummary | undefined, selectedRuntime?: string): BotRuntimeOption[] {
  const rt = machine?.availableRuntimes ?? []
  const normalized = rt.map((r) =>
    typeof r === "string"
      ? { id: r, unhealthy: false }
      : {
          id: r.id,
          ...(r.reasoning !== undefined ? { reasoning: r.reasoning } : {}),
          unhealthy: r.status === "unhealthy",
        },
  )
  return visibleRuntimes(normalized, selectedRuntime).sort((a, b) => Number(a.unhealthy) - Number(b.unhealthy))
}

export function firstHealthyRuntimeId(options: BotRuntimeOption[]): string {
  return options.find((o) => !o.unhealthy)?.id ?? ""
}

export function replaceMachines(data: MachinesResponse, machines: MachineSummary[]): MachinesResponse {
  return {
    ...data,
    machines,
    ...(data.machineCapacity ? { machineCapacity: {
      ...data.machineCapacity,
      ownedCount: machines.length,
      onlineCount: machines.filter(machine => isPresenceOnline(machine.status)).length,
    } } : {}),
  }
}
