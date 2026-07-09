import { NextResponse } from "next/server"
import { queries, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const DELETE = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string

  if (!id) {
    return writeError("friendship id is required", 400)
  }

  const friendship = await queries.communityFriendship.getFriendship(db, id)
  if (!friendship) {
    return writeError("friendship not found", 404)
  }

  if (friendship.requesterId !== ctx.userId && friendship.addresseeId !== ctx.userId) {
    return writeError("not a participant in this friendship", 403)
  }

  if (friendship.status !== "accepted") {
    return writeError("friendship is not accepted", 400)
  }

  await queries.communityFriendship.removeFriend(db, id)

  const otherUserId = friendship.requesterId === ctx.userId
    ? friendship.addresseeId
    : friendship.requesterId

  broadcastToUserSafe(otherUserId, {
    type: WS_EVENTS.FRIEND_REMOVE,
    friendshipId: id,
  })

  return new NextResponse(null, { status: 204 })
})
