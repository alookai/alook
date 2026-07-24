import { nanoid } from "nanoid"
import { queries, makeRuntimeConfig, formatHandle, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"
import { pushAgentResetToMachine } from "@/lib/community/bot-push"

/**
 * Owner-triggered synchronous session reset.
 *
 * Flow: owner-scoped bot lookup → build RuntimeConfig → push `agent:reset`
 * over WS to the bot's daemon → if delivered (`sent > 0`), write the
 * `session_reset` audit row and broadcast it. If the daemon is offline
 * (`sent === 0`), return 409 and NEVER touch the audit log — the audit row
 * signals a real reset landed at the daemon, not a click.
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

  const inserted = await queries.communityBotAuditLog.insertBotAuditSessionReset(db, {
    botId: id,
    actorId: ctx.userId,
  })
  if (inserted) {
    try {
      await broadcastToUser(ctx.userId, {
        type: WS_EVENTS.BOT_AUDIT_EVENT,
        botId: id,
        id: inserted.id,
        kind: "session_reset",
        payload: {},
        sessionId: null,
        launchId: null,
        createdAt: inserted.createdAt,
      })
    } catch {
      // Best-effort — D1 row is authoritative.
    }
  }

  return writeJSON({ ok: true })
})
