import { queries, BotCreationSubmitSchema, BOT_CREATION_BODY_MAX_BYTES, readBoundedJsonRequest, formatHandle } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { botCreationFailure } from "@/lib/community/bot-creation.server"
import { dispatchCommittedMessage } from "@/lib/community/message-dispatcher"

export const POST = withCommunityActor(async (req, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const raw = await readBoundedJsonRequest(req, BOT_CREATION_BODY_MAX_BYTES)
  if (!raw.ok && raw.reason === "oversized") return writeJSON({ error: "Creation request is too large", code: "REQUEST_TOO_LARGE" }, 413)
  const parsed = BotCreationSubmitSchema.safeParse(raw.ok ? raw.value : null)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const index = issue?.path[0] === "bots" && typeof issue.path[1] === "number" ? issue.path[1] + 1 : undefined
    return writeJSON({ error: issue?.message ?? "Invalid creation proposal", code: issue?.path.at(-1) === "reason" && issue.code === "too_small" ? "REASON_REQUIRED" : "INVALID_PROPOSAL", ...(index ? { itemIndex: index } : {}), field: issue?.path.at(-1) }, 400)
  }
  const db = getPrimaryDb(ctx.env.DB)
  try {
    const result = await queries.communityBotCreation.submitCreationRequest(db, gate.bot.ownerUserId, gate.bot.userId, parsed.data)
    if (result.isNew) await dispatchCommittedMessage(db, result.row.messageId)
    const owner = await queries.user.getUserPublic(db, gate.bot.ownerUserId)
    return writeJSON({ kind: "bot_creation_request", requestId: result.row.id, status: result.row.status, count: result.row.bots.length,
      cardMessageId: result.row.messageId, dmRef: owner ? `/.dm/${formatHandle(owner.name, owner.discriminator)}` : null,
      hint: "Your owner must approve this request in DM before any bots are created." }, result.isNew ? 201 : 200)
  } catch (error) { return botCreationFailure(error) }
})
