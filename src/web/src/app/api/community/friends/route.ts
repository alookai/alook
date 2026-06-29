import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const [rawFriends, rawBlocked] = await Promise.all([
    queries.communityFriendship.listFriends(db, ctx.userId),
    queries.communityFriendship.listBlocked(db, ctx.userId),
  ])
  const friends = rawFriends.map((f) => ({
    id: f.id,
    userId: f.friendUserId,
    name: f.friendName ?? "",
    avatar: f.friendImage ?? (f.friendName ?? "?").charAt(0).toUpperCase(),
    status: "offline" as const,
    sub: "",
  }))
  const blocked = rawBlocked.map((b) => ({
    id: b.id,
    userId: b.blockedUserId,
    name: b.blockedName ?? "",
    avatar: b.blockedImage ?? (b.blockedName ?? "?").charAt(0).toUpperCase(),
  }))
  return writeJSON({ friends, blocked })
})
