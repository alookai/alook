import { NextRequest } from "next/server"
import { CommunityBotActivationRequestSchema, queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { pushBotEventToMachine } from "@/lib/community/bot-push"
import { fanOutPresenceUpdate } from "@/lib/community/fanout"
import { log } from "@/lib/logger"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const id = ctx.params?.id as string
  const [body, error] = await parseBody(req, CommunityBotActivationRequestSchema)
  if (error) return error

  const db = getDb(ctx.env.DB)
  const result = await queries.communityBot.setBotActive(db, id, ctx.userId, body.active)
  if (result.state === "not_found") return writeError("bot not found", 404)
  if (result.state === "capacity") {
    return writeJSON({
      error: "BOT_ACTIVE_LIMIT_REACHED",
      plan: result.capacity.plan.id,
      planDisplayName: result.capacity.plan.displayName,
      limit: result.capacity.limit,
      ownedCount: result.capacity.ownedCount,
      activeCount: result.capacity.activeCount,
    }, 409)
  }

  const changed = result.state === "updated"
  if (changed) {
    if (body.active) {
      try {
        const owner = await queries.user.getUserPublic(db, ctx.userId)
        if (owner && result.bot.machineId) {
          await pushBotEventToMachine(ctx.env, result.bot.machineId, {
            type: "bot:added",
            botId: result.bot.id,
            name: result.bot.name,
            discriminator: result.bot.discriminator,
            description: result.bot.description || undefined,
            ownerName: owner.name,
            ownerDiscriminator: owner.discriminator,
          })
        }
        // Deactivation forced an Offline projection. If this binding's machine
        // is already online, publish the matching Online edge immediately so
        // viewers do not stay stale until the next daemon presence transition.
        if (await queries.communityMachine.isBotOnline(db, result.bot.id)) {
          await fanOutPresenceUpdate(result.bot.id, true, result.bot.ownerUserId)
        }
      } catch (err) {
        // The entitlement transition already committed. Delivery is
        // best-effort; cold-start roster and presence reads remain
        // authoritative if this immediate edge fails.
        log.warn("bot_activation_post_commit_delivery_failed", {
          botId: result.bot.id,
          err: String(err),
        })
      }
    } else if (result.bot.machineId) {
      await pushBotEventToMachine(ctx.env, result.bot.machineId, {
        type: "bot:removed",
        botId: result.bot.id,
      })
      await fanOutPresenceUpdate(result.bot.id, false, result.bot.ownerUserId)
    }
  }

  return writeJSON({
    bot: { id: result.bot.id, isActive: result.bot.isActive },
    changed,
  })
})
