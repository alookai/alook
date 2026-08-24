import { queries, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const POST = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  // Resolve the viewer's visible channels once (top-level + child threads,
  // parent-climbed) and scope the mark-all to them — a private thread under an
  // invisible parent is excluded.
  const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
  const { count, snapshot } = await queries.communityReadState.markAllServerChannelsRead(db, ctx.userId, visibleChannelIds)
  if (snapshot) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.INBOX_CHANGED,
      revision: snapshot.revision,
      inboxChanged: true,
      reason: "read_all",
    })
  }
  return writeJSON({ ok: true, count, revision: snapshot?.revision ?? null })
})
