import { queries, requiresExplicitModel, type CommunityMachineRuntime, type RuntimeReasoningCatalog } from "@alook/shared"
import type { Database } from "@alook/shared"

export async function readPlatformMachines(db: Database, ownerId: string, requesterMachineId: string) {
  const machines = await queries.communityMachine.listMachinesForUser(db, ownerId)
  return { machines: machines.map((machine) => ({ id: machine.id, name: machine.displayName, status: machine.status, daemonVersion: machine.daemonVersion })), requesterMachineId }
}

export function projectModelOptions(machineId: string, runtime: Pick<CommunityMachineRuntime, "id" | "reasoning">, model?: string | null) {
  const catalog: RuntimeReasoningCatalog | undefined = runtime.reasoning
  const base = { machineId, backendId: runtime.id, source: "stored_report", readAt: new Date().toISOString(), observedAt: null,
    catalogOrigin: catalog?.catalogOrigin ?? "unknown", catalogState: catalog ? "reported" : "not_reported", modelRequired: requiresExplicitModel(runtime.id) }
  const present = (entry: NonNullable<RuntimeReasoningCatalog["models"]>[number]) => ({ id: entry.id, ...(entry.displayName ? { displayName: entry.displayName } : {}), reasoningEfforts: entry.supportedReasoningEfforts, defaultReasoningEffort: entry.defaultReasoningEffort ?? null })
  if (model != null) {
    const entry = catalog?.models.find((entry) => entry.id === model)
    return { ...base, inCatalog: Boolean(entry), model: entry ? present(entry) : { id: model, reasoningEfforts: null, defaultReasoningEffort: null } }
  }
  return { ...base, defaultModelId: catalog?.defaultModelId ?? null, models: catalog ? catalog.models.map(present) : null }
}
