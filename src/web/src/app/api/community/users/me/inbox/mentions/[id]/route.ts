import { queries, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const DELETE = withAuth(async (_req, ctx) => {
  const mentionId = ctx.params?.id
  if (!mentionId) return writeError("missing mention id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const result = await queries.communityMention.dismissMentionWithRevision(
    db,
    ctx.userId,
    mentionId,
  )
  if (!result.changed) return writeError("mention not found", 404)

  await broadcastToUserSafe(ctx.userId, {
    type: WS_EVENTS.INBOX_CHANGED,
    reason: "mention_dismiss",
    inboxChanged: true,
    revision: result.revision,
  })
  return writeJSON({ ok: true, ...result })
})
