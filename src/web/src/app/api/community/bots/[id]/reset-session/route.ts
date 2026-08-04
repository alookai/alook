import { nanoid } from "nanoid"
import { queries, makeRuntimeConfig, resolveModelConfig, formatHandle } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { pushAgentResetToMachine } from "@/lib/community/bot-push"

/**
 * Owner-triggered synchronous session reset.
 *
 * Flow: owner-scoped bot lookup → build RuntimeConfig → push `agent:reset`
 * over WS to the bot's daemon → if delivered (`sent > 0`), return. If the
 * daemon is offline (`sent === 0`), return 409.
 *
 * The `session_reset` audit row + awake-time stamp + broadcast are NOT written
 * here: they are re-homed to the daemon completion signal (the `agent_session`
 * frame at reborn-ready), so the record reflects "the reset actually completed"
 * rather than "the command was dispatched." See plans/reset-nap-completion-rehome.md.
 */
export const POST = withAuth(async (_req, ctx) => {
  const id = ctx.params?.id as string
  const db = getDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  if (!bot.machineId) return writeError("bot has no active binding", 409)

  const wakeCtx = await queries.communityBot.getBotWakeContext(db, id)
  if (wakeCtx.state !== "ready") return writeError(wakeCtx.state, 409)

  const config = makeRuntimeConfig({
    runtime: wakeCtx.runtime,
    model: resolveModelConfig(wakeCtx.runtime, wakeCtx.modelName),
    agentName: wakeCtx.name,
    agentHandle: `@${formatHandle(wakeCtx.name, wakeCtx.discriminator)}`,
  })
  const launchId = nanoid()

  const { sent } = await pushAgentResetToMachine(ctx.env, bot.machineId, {
    agentId: id,
    config,
    launchId,
  })
  if (sent === 0) {
    return writeError("bot is offline — bring it online before resetting", 409)
  }

  return writeJSON({ ok: true })
})
