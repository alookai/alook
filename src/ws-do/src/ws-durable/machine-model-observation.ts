import { AgentModelMessageSchema, createDb, queries, withD1Retry } from "@alook/shared"
import { handleFrameForBoundBot } from "./bound-bot-frame"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"

export async function handleModelObservationFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const result = AgentModelMessageSchema.safeParse(parsed)
  if (!result.success) return false
  const { type: _, ...report } = result.data
  if (Date.parse(report.observedAt) > Date.now() + 5 * 60_000) return true
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "agent_model", agentId: report.agentId, machineId: identity.machineId,
    resolveBinding: () => queries.communityBot.getBotOwnedBy(db, report.agentId, identity.userId),
    isMatch: (binding) => binding.isActive && binding.machineId === identity.machineId
      && binding.ownerUserId === identity.userId && binding.runtime === report.backendId,
    write: async () => {
      await withD1Retry(() => queries.communityBot.recordBotModelObservation(db, identity.userId, identity.machineId, report),
        { route: "ws-do:agent-model-observation" })
    },
  })
  return true
}
