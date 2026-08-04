import { nanoid } from "nanoid"
import { queries, makeRuntimeConfig, resolveModelConfig, formatHandle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { pushBatchResetToMachine } from "@/lib/community/bot-push"

/**
 * Owner-triggered BATCH reset — reset EVERY agent bound to a machine in one
 * command (my-bots machine-category "Reset all" button).
 *
 * Flow: owner-scope the machine → enumerate its full binding set
 * (`listBotsForMachine`, all bound bots regardless of running state — a
 * bound-but-idle bot cold-starts on reset, scope ②) → build a per-agent
 * RuntimeConfig (same as single-reset) → push ONE `machine:reset_all` frame to
 * the machine's daemon (server packs the array; the daemon does NOT re-enumerate
 * and gates each agentId on its own `botsById`). If delivered (`sent > 0`)
 * return `{ dispatched: N }`; if the daemon is offline (`sent === 0`) return 409.
 *
 * v1 is DISPATCH-level (Gus 架构#825): we confirm the daemon RECEIVED the batch,
 * not per-agent reset completion — matching single-reset's fire-and-confirm-
 * delivery honesty. No per-agent success tracking (that'd be a v2 correlated-ack
 * path the control channel doesn't have). See plans/daemon-batch-reset.md.
 */
export const POST = withAuth(async (_req, ctx) => {
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
      model: resolveModelConfig(bot.runtime, bot.modelName),
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
