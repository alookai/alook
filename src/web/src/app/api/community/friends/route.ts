import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const [friends, blocked] = await Promise.all([
    queries.communityFriendship.listFriends(db, ctx.userId),
    queries.communityFriendship.listBlocked(db, ctx.userId),
  ])
  return writeJSON({ friends, blocked })
})
