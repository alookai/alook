import { NextRequest } from "next/server"
import { queries, parseNameAndTag, isBlocked } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireNotBlocked } from "@/lib/community/permissions"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { userId?: string; username?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  let targetUserId = body.userId
  if (!targetUserId && body.username) {
    const handle = parseNameAndTag(body.username)
    const targetUser = handle
      ? await queries.user.getUserByNameAndDiscriminator(db, handle.name, handle.discriminator)
      : await queries.user.getUserByNameCaseInsensitive(db, body.username)
    if (!targetUser) return writeError("user not found", 404)
    targetUserId = targetUser.id
  }

  if (!targetUserId) {
    return writeError("userId or username is required", 400)
  }

  if (targetUserId === ctx.userId) {
    return writeError("cannot send friend request to yourself", 400)
  }

  const target = await queries.user.getUserInternal(db, targetUserId)
  if (!target || target.deletedAt !== null) return writeError("user not found", 404)

  // Owner ↔ own-bot is a synthetic friendship — no row can exist. 409 so the UI
  // treats it as a no-op. Covers both directions: a human adding their own bot,
  // and a bot actor targeting its own owner.
  if (target.isBot === true && target.ownerUserId === ctx.userId) {
    return writeError("already friends", 409)
  }
  if (ctx.isBot && ctx.ownerUserId && targetUserId === ctx.ownerUserId) {
    return writeError("already friends", 409)
  }

  const block = await requireNotBlocked(db, ctx.userId, targetUserId)
  if (!block.ok) return writeError(block.error, block.status)

  try {
    const result = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: targetUserId,
    })
    // The query owns supersede + card writes + broadcast payloads; the route
    // just relays them.
    for (const b of result.broadcasts) {
      await broadcastToUserSafe(b.userId, b.event)
    }
    for (const supersededId of result.supersededIds) {
      logAudit(db, {
        serverId: null,
        actorId: ctx.userId,
        action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUEST_SUPERSEDED,
        targetType: "friendship",
        targetId: supersededId,
        changes: JSON.stringify({ supersededBy: result.friendship.id }),
      })
    }

    // A bot expects the discriminated FriendRequestResult; a human keeps the
    // raw friendship row (201 created / 200 auto-accepted). Sibling / crossover
    // auto-accept → status "accepted" (no gate); anything else the bot posted is
    // owner-gated pending, so surface the owner-approval hint.
    if (ctx.isBot) {
      if (result.kind === "auto_accepted") {
        return writeJSON({ friendshipId: result.friendship.id, status: "accepted", hint: null }, 200)
      }
      const owner = ctx.ownerUserId ? await queries.user.getUserPublic(db, ctx.ownerUserId) : null
      const ownerDisplayName = owner?.name ?? "your owner"
      return writeJSON(
        {
          friendshipId: result.friendship.id,
          status: "pending",
          hint: `Your owner ${ownerDisplayName} needs to approve this request in DM.`,
        },
        200,
      )
    }

    if (result.kind === "auto_accepted") {
      return writeJSON(result.friendship, 200)
    }
    return writeJSON(result.friendship, 201)
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (isBlocked(err.message)) return writeError("blocked", 403)
      if (err.message === "already friends") return writeError("already friends", 409)
      if (err.message === "friend request already sent") {
        return writeError("friend request already sent", 409)
      }
    }
    throw err
  }
})
