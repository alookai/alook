import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const machines = await queries.communityMachine.listMachinesForUser(db, ctx.userId)
  const quotaByMachine = await queries.communityMachine.listMachineBackendQuotasForUser(db, ctx.userId)
  const now = Date.now()
  const withQuota = machines.map((machine) => {
    const stored = quotaByMachine.get(machine.id) ?? []
    const quota = machine.availableRuntimes.map((runtime) => {
      const capability = runtime.id === "claude" || runtime.id === "codex"
        ? "supported" as const
        : runtime.id === "cursor" || runtime.id === "opencode" || runtime.id === "pi"
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
  return writeJSON({ machines: withQuota })
})
