import { withAuth } from "@/lib/middleware/auth-policy"
import { DECISION_CARD_MESSAGE_TYPE, queries, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const DELETE = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing todo message id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message || message.type !== DECISION_CARD_MESSAGE_TYPE || message.authorId === ctx.userId) {
    return writeError("question message not found", 404)
  }

  const readable = await queries.communityChannel.listReadableMessageChannelsForUser(
    db,
    ctx.userId,
    [message.channelId],
  )
  if (readable.length === 0) {
    return writeError("question message not found", 404)
  }

  const result = await queries.communityInbox.dismissQuestionTodoWithRevision(
    db,
    ctx.userId,
    messageId,
  )
  if (result.changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.INBOX_CHANGED,
      reason: "todo_dismiss",
      inboxChanged: true,
      revision: result.revision,
    })
  }
  return writeJSON({ ok: true, ...result })
})
