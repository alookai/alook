import { queries, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

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

  broadcastToUserSafe(targetId, {
    type: WS_EVENTS.FRIEND_BLOCK,
    userId: ctx.userId,
  })

  // If blocking tore down an existing accepted friendship, tell the other
  // side so their friend list reflects it.
  if (result.removedFriendshipId) {
    broadcastToUserSafe(targetId, {
      type: WS_EVENTS.FRIEND_REMOVE,
      friendshipId: result.removedFriendshipId,
    })
  }

  return writeJSON(result.row)
})
