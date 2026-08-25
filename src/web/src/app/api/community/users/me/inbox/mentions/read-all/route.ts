import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getPrimaryDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const POST = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const result = await queries.communityMention.markAllMentionsReadWithRevision(db, ctx.userId)
  if (result.changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.INBOX_CHANGED,
      reason: "mention_read_all",
      inboxChanged: true,
      revision: result.revision,
    })
  }
  return writeJSON({ ok: true, ...result })
})
