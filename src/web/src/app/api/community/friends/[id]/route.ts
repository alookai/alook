import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

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

  // Cast to any because community events aren't in the WsMessage union
  broadcastToUser(otherUserId, { type: "community:friend.remove", friendshipId: id } as any).catch(() => {})

  return new NextResponse(null, { status: 204 })
})
