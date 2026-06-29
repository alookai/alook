import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { userId?: string; username?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  let targetUserId = body.userId
  if (!targetUserId && body.username) {
    const targetUser = await queries.user.getUserByNameCaseInsensitive(db, body.username)
    if (!targetUser) return writeError("user not found", 404)
    targetUserId = targetUser.id
  }

  if (!targetUserId) {
    return writeError("userId or username is required", 400)
  }

  if (targetUserId === ctx.userId) {
    return writeError("cannot send friend request to yourself", 400)
  }

  try {
    const friendship = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: targetUserId,
    })

    // Cast to any because community events aren't in the WsMessage union
    broadcastToUser(targetUserId, { type: "community:friend.request", friendship } as any).catch(() => {})

    return writeJSON(friendship, 201)
  } catch (err: unknown) {
    const full = err instanceof Error
      ? err.message + (err.cause instanceof Error ? " " + err.cause.message : "")
      : String(err)
    if (full.includes("UNIQUE constraint")) {
      return writeError("friend request already sent", 409)
    }
    throw err
  }
})
