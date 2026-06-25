import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string

  if (!id) {
    return writeError("friendship id is required", 400)
  }

  const friendship = await queries.communityFriendship.getFriendship(db, id)

  if (!friendship) {
    return writeError("friendship not found", 404)
  }

  if (friendship.addresseeId !== ctx.userId) {
    return writeError("only the addressee can reject a friend request", 403)
  }

  if (friendship.status !== "pending") {
    return writeError("request is not pending", 400)
  }

  await queries.communityFriendship.rejectRequest(db, id)

  // Cast to any because community events aren't in the WsMessage union
  broadcastToUser(friendship.requesterId, { type: "community:friend.reject", friendshipId: id } as any).catch(() => {})

  return writeJSON({ ok: true })
})
