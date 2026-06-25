import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  if (!targetId) {
    return writeError("userId is required", 400)
  }

  if (targetId === ctx.userId) {
    return writeError("cannot block yourself", 400)
  }

  const result = await queries.communityFriendship.block(db, {
    blockerId: ctx.userId,
    targetId,
  })

  // Cast to any because community events aren't in the WsMessage union
  broadcastToUser(targetId, { type: "community:friend.block", userId: ctx.userId } as any).catch(() => {})

  return writeJSON(result)
})
