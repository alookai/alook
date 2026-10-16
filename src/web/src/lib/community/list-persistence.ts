import { z } from "zod"
import { CommunityMachineSummarySchema, ReasoningEffortSchema } from "@alook/shared"

const machineSchema = CommunityMachineSummarySchema.pick({ id: true, hostname: true, displayName: true, platform: true, arch: true, osRelease: true, daemonVersion: true, createdAt: true, updatedAt: true }).strip()
const botSchema = z.object({ id: z.string(), machineId: z.string(), runtime: z.string(), modelName: z.string().nullable(), reasoningEffort: ReasoningEffortSchema.nullable(), runtimeConfigRevision: z.number() })

export function isCommunityListResourceKey(key: readonly unknown[]) {
  return key.length === 2 && key[0] === "community" && (key[1] === "bots" || key[1] === "machines")
}

export function persistentCommunityListResource(key: readonly unknown[], data: unknown) {
  if (!isCommunityListResourceKey(key)) return
  if (key[1] === "machines") {
    const parsed = z.object({ machines: z.array(machineSchema), complete: z.boolean().optional() }).safeParse(data)
    if (parsed.success && parsed.data.complete !== false) return { machines: parsed.data.machines, complete: true, observed: false, source: "restored_idb" }
  } else {
    const parsed = z.object({ bots: z.array(botSchema) }).safeParse(data)
    if (parsed.success) return { bots: parsed.data.bots, observed: false, source: "restored_idb" }
  }
}
