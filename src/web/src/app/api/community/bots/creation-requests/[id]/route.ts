import { queries, BotCreationDecisionSchema, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { botCreationFailure, completeBotCreation } from "@/lib/community/bot-creation.server"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const PATCH = withCommunityActor(async (req, ctx) => {
  if (ctx.actor.kind !== "human" || ctx.actor.isBot) return writeError("Only the human owner can decide", 403)
  const [body, error] = await parseBody(req, BotCreationDecisionSchema)
  if (error) return error
  const db = getPrimaryDb(ctx.env.DB)
  try {
    const result = await queries.communityBotCreation.decideCreationRequest(db, ctx.actor.userId, ctx.params?.id as string, body.decision)
    const botCreation = queries.communityBotCreation.projectCreationRequest(result.row)
    if (result.changed && result.row.status === "approved") {
      const owner = await queries.user.getUserPublic(db, ctx.actor.userId)
      if (owner) await completeBotCreation(ctx.env, db, ctx.actor.userId, owner, result.row.bots.flatMap((item) => item.createdBot ? [{ ...item.createdBot, description: item.description, machineId: item.machineId }] : []))
    }
    if (result.changed) await broadcastToUserSafe(ctx.actor.userId, { type: WS_EVENTS.MESSAGE_UPDATED, channelId: result.row.channelId, messageId: result.row.messageId, botCreation })
    return writeJSON({ botCreation })
  } catch (error) {
    if (error instanceof queries.communityBotCreation.BotCreationError) {
      const current = await queries.communityBotCreation.getCreationRequest(db, ctx.params?.id as string, { ownerId: ctx.actor.userId })
      return botCreationFailure(error, { requestId: ctx.params?.id, ...(current ? { status: current.status } : {}) })
    }
    return botCreationFailure(error)
  }
})
