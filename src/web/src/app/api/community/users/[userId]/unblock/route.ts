import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  if (!targetId) {
    return writeError("userId is required", 400)
  }

  const result = await queries.communityFriendship.unblock(db, {
    blockerId: ctx.userId,
    targetId,
  })

  if (!result) {
    return writeError("no blocked relationship found", 404)
  }

  return writeJSON(result)
})
