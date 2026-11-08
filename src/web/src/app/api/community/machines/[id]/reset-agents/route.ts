import { withAuth } from "@/lib/middleware/auth-policy"
import { nanoid } from "nanoid"
import { queries, makeRuntimeConfig, resolveModelConfig, formatHandle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { pushBatchResetToMachine } from "@/lib/community/bot-push"

/**
 * Dispatch confirms daemon receipt of the batch, not completion of each reset.
 * Include idle bound bots; the daemon validates each binding independently.
 */
export const POST = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const machineId = ctx.params?.id as string
  if (!machineId) return writeError("machine id is required", 400)
  const db = getDb(ctx.env.DB)

  // Owner-scope: the machine must belong to the caller (query-layer
  // listBotsForMachine is not owner-scoped by design — the check lives here).
  const machine = await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, machineId)
  if (!machine) return writeError("machine not found", 404)

  const bots = await queries.communityBot.listBotsForMachine(db, machineId)
  if (bots.length === 0) {
    // Nothing bound to this machine — nothing to reset.
    return writeJSON({ dispatched: 0 })
  }

  const resets = bots.map((bot) => ({
    agentId: bot.id,
    config: makeRuntimeConfig({
      runtime: bot.runtime,
      model: resolveModelConfig(bot.modelName),
      reasoningEffort: bot.reasoningEffort ?? undefined,
      runtimeConfigRevision: bot.runtimeConfigRevision,
      agentName: bot.name,
      agentHandle: `@${formatHandle(bot.name, bot.discriminator)}`,
    }),
    launchId: nanoid(),
  }))

  const { sent } = await pushBatchResetToMachine(ctx.env, machineId, resets)
  if (sent === 0) {
    return writeError("machine is offline — bring its daemon online before resetting", 409)
  }

  return writeJSON({ dispatched: resets.length })
})
