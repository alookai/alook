import { queries, type Database } from "@alook/shared"

export async function readCommunityMachines(db: Database, userId: string) {
    const [machines, entitlement] = await Promise.all([
      queries.communityMachine.listMachinesForUser(db, userId),
      queries.productPlan.resolveMachinesMaxForUser(db, userId),
    ])
    const machineCapacity = {
      plan: entitlement.plan,
      isFounder: entitlement.isFounder,
      limit: entitlement.value,
      ownedCount: machines.length,
      onlineCount: machines.filter((machine) => machine.status === "online").length,
    }
    const quotaByMachine = await queries.communityMachine.listMachineBackendQuotasForUser(db, userId)
    const now = Date.now()
    const withQuota = machines.map((machine) => {
      const stored = quotaByMachine.get(machine.id) ?? []
      const quota = machine.availableRuntimes.map((runtime) => {
        const capability = runtime.id === "claude" || runtime.id === "codex" || runtime.id === "grok" || runtime.id === "antigravity"
          ? "supported" as const
          : runtime.id === "cursor" || runtime.id === "opencode" || runtime.id === "pi" || runtime.id === "agy"
            ? "unsupported" as const
            : "unknown" as const
        const runtimeState = machine.status === "offline"
          ? "offline" as const
          : runtime.status === "unhealthy"
            ? "unhealthy" as const
            : "healthy" as const
        const current = stored.find((entry) => entry.quota.agentBackendId === runtime.id)
        const observation = current?.quota.observation
        const snapshot = !current || !observation
          ? { status: "pending" as const }
          : observation.status === "error"
            ? { status: "error" as const, code: observation.code }
            : {
                status: now <= Date.parse(current.observedAt) + observation.freshForSeconds * 1_000
                  ? "available" as const
                  : "stale" as const,
                observedAt: current.observedAt,
                ...(observation.planName ? { planName: observation.planName } : {}),
                limits: observation.limits,
              }
        return {
          scope: { kind: "machine_backend" as const, machineId: machine.id, agentBackendId: runtime.id },
          capability,
          runtimeState,
          snapshot,
        }
      })
      return { ...machine, quota }
    })
    return { machines: withQuota, machineCapacity }
}

export async function readCommunityMachineList(db: Database, userId: string) {
  return { machines: await queries.communityMachine.listMachinesForUser(db, userId) }
}

export async function readCommunityMachineObservations(db: Database, userId: string) {
  const { machines, machineCapacity } = await readCommunityMachines(db, userId)
  return { machineCapacity, quotas: machines.map(({ id, quota }) => ({ machineId: id, quota })) }
}
