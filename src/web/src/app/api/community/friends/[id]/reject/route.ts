import { queries, WS_EVENTS } from "@alook/shared"
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
  if (!friendship) return writeError("friendship not found", 404)
  // Either side of a pending request can tear it down: the addressee is
  // rejecting, the requester is cancelling their own outgoing request. The
  // DB query is atomic on `status = 'pending'` so we can't accidentally
  // delete an accepted friendship here.
  if (friendship.requesterId !== ctx.userId && friendship.addresseeId !== ctx.userId) {
    return writeError("not a participant in this friend request", 403)
  }

  const deleted = await queries.communityFriendship.rejectRequest(db, id)
  if (!deleted) return writeError("request is not pending", 400)

  const otherUserId = friendship.requesterId === ctx.userId
    ? friendship.addresseeId
    : friendship.requesterId
  broadcastToUser(otherUserId, {
    type: WS_EVENTS.FRIEND_REJECT,
    friendshipId: id,
  } as never).catch(() => {})

  return writeJSON({ ok: true })
})
