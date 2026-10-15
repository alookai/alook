"use client"
import { useMemo } from "react"
import { useQuery, type UseQueryResult, type UseQueryOptions } from "@tanstack/react-query"
import { isPresenceOnline } from "@alook/shared"
import { machinesOptions, machineObservationsOptions, type MachinesResponse, type MachineSummary } from "@/lib/community/machines"
export type { MachineBackendQuota, MachineSummary, MachinesResponse } from "@/lib/community/machines"

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

// Frozen empty fallback — see `use-servers.ts` for the rationale.
const EMPTY_MACHINES: readonly MachineSummary[] = Object.freeze([])

export const machinesQueryFn = machinesOptions().queryFn!

export function useMachines(options?: Pick<UseQueryOptions<MachinesResponse>, "subscribed" | "refetchInterval"> & { enabled?: boolean }): UseQueryResult<MachinesResponse> & {
  machines: MachineSummary[]
  capacityPending: boolean
} {
  const query = useQuery({
    ...machinesOptions(),
    ...options,
  })
  const observations = useQuery({ ...machineObservationsOptions(), enabled: options?.enabled, subscribed: options?.subscribed })
  const machines = useMemo(() => !observations.data?.quotas?.length ? query.data?.machines ?? (EMPTY_MACHINES as MachineSummary[]) : query.data?.machines.map(machine => {
    const quota = observations.data?.quotas?.find(row => row.machineId === machine.id)?.quota
    return quota ? { ...machine, quota } : machine
  }) ?? (EMPTY_MACHINES as MachineSummary[]), [query.data?.machines, observations.data])
  const capacity = query.data?.complete !== false && query.data?.observed !== false && machines.every(machine => machine.status !== undefined)
    ? observations.data?.machineCapacity
    : undefined
  const data = useMemo(() => query.data ? { ...query.data, machines, ...(capacity ? { machineCapacity: { ...capacity, ownedCount: machines.length, onlineCount: machines.filter(machine => isPresenceOnline(machine.status)).length } } : {}) } : undefined, [query.data, machines, capacity])
  return { ...query, data, machines, capacityPending: !capacity && observations.isPending && !observations.isError } as UseQueryResult<MachinesResponse> & { machines: MachineSummary[]; capacityPending: boolean }
}
