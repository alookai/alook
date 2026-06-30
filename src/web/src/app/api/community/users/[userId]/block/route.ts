import { queries, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  if (!targetId) return writeError("userId is required", 400)
  if (targetId === ctx.userId) return writeError("cannot block yourself", 400)

  const target = await queries.user.getUser(db, targetId)
  if (!target) return writeError("user not found", 404)

  const result = await queries.communityFriendship.block(db, {
    blockerId: ctx.userId,
    targetId,
  })

  broadcastToUser(targetId, {
    type: WS_EVENTS.FRIEND_BLOCK,
    userId: ctx.userId,
  } as never).catch(() => {})

  // If we converted an accepted friendship into a block, tell the other side
  // their friend list lost an entry so the UI stays consistent.
  if (result.status === "blocked") {
    broadcastToUser(targetId, {
      type: WS_EVENTS.FRIEND_REMOVE,
      friendshipId: result.id,
    } as never).catch(() => {})
  }

  return writeJSON(result)
})
