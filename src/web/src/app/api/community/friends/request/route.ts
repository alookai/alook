import { NextRequest } from "next/server"
import { queries, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"
import { requireNotBlocked } from "@/lib/community/permissions"

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

  // Make sure the user exists; also avoids leaking block state vs unknown user.
  const target = await queries.user.getUser(db, targetUserId)
  if (!target) return writeError("user not found", 404)

  // Surface block as 403 explicitly — same response code as DM, so a blocked
  // user can't enumerate "block" vs "friendship exists" via timing/error text.
  const block = await requireNotBlocked(db, ctx.userId, targetUserId)
  if (!block.ok) return writeError(block.error, block.status)

  try {
    const friendship = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: targetUserId,
    })

    broadcastToUser(targetUserId, { type: WS_EVENTS.FRIEND_REQUEST, friendship } as never).catch(() => {})

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
