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
    const result = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: targetUserId,
    })

    if (result.kind === "auto_accepted") {
      // Both sides had pending intents; promoting to accepted is the
      // right behaviour. Notify the other party as if they had accepted
      // an outbound request from us.
      broadcastToUser(targetUserId, {
        type: WS_EVENTS.FRIEND_ACCEPT,
        friendshipId: result.friendship.id,
      } as never).catch(() => {})
      return writeJSON(result.friendship, 200)
    }

    broadcastToUser(targetUserId, {
      type: WS_EVENTS.FRIEND_REQUEST,
      friendship: result.friendship,
    } as never).catch(() => {})
    return writeJSON(result.friendship, 201)
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message === "blocked") return writeError("blocked", 403)
      if (err.message === "already friends") return writeError("already friends", 409)
    }
    const full = err instanceof Error
      ? err.message + (err.cause instanceof Error ? " " + err.cause.message : "")
      : String(err)
    if (full.includes("UNIQUE constraint")) {
      return writeError("friend request already sent", 409)
    }
    throw err
  }
})
