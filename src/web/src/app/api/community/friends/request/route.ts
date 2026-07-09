import { NextRequest } from "next/server"
import { queries, WS_EVENTS, isUniqueConstraintError, parseNameAndTag } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireNotBlocked } from "@/lib/community/permissions"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

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
    // `name#0042` exact match first — same-name users can't get friended by
    // mistake once a discriminator is given. Falls back to the existing
    // case-insensitive bare-name match when no `#dddd` suffix is present.
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

  // Make sure the user exists; also avoids leaking block state vs unknown user.
  // Use `getUserInternal` here so we can detect isBot and route into the
  // bot-approval flow. Filter deleted so `deletedAt IS NOT NULL` reads as 404.
  const target = await queries.user.getUserInternal(db, targetUserId)
  if (!target || target.deletedAt !== null) return writeError("user not found", 404)

  // Surface block as 403 explicitly — same response code as DM, so a blocked
  // user can't enumerate "block" vs "friendship exists" via timing/error text.
  const block = await requireNotBlocked(db, ctx.userId, targetUserId)
  if (!block.ok) return writeError(block.error, block.status)

  // ── Bot targets ─────────────────────────────────────────────────────────
  //
  // If the target is a bot, route through the approval-request flow: write a
  // DM card to the owner, insert a pending communityBotApprovalRequest. From
  // Bob's UI, the confirmation string is identical to a human friend-request
  // response — this is the strongest pass-as-human invariant.
  if (target.isBot === true) {
    // Owner ↔ own-bot is an implicit friendship — `listFriends` synthesizes
    // the row, and `areFriends` returns true. Return 409 "already friends" so
    // the UI can treat it as a no-op instead of surfacing an error.
    if (target.ownerUserId === ctx.userId) {
      return writeError("already friends", 409)
    }
    if (!target.ownerUserId) return writeError("user not found", 404)

    // Idempotency guard — matches the existing human 409 shape.
    const pending = await queries.communityBot.findPendingFriendRequest(
      db,
      target.id,
      ctx.userId,
    )
    if (pending) return writeError("friend request already sent", 409)

    // Owner ↔ bot DM (may need to be created).
    const dm = await queries.communityDm.createOrGetDM(db, {
      userId1: target.id,
      userId2: target.ownerUserId,
    })
    const msg = await queries.communityMessage.createMessage(db, {
      authorId: target.id,
      content: "A friend wants to be my friend. Approve?",
      dmConversationId: dm.id,
    })
    try {
      await queries.communityBot.createApprovalRequestStatement(db, {
        botId: target.id,
        kind: "friend",
        serverId: null,
        requestedByUserId: ctx.userId,
        dmMessageId: msg.id,
      })
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return writeError("friend request already sent", 409)
      }
      throw err
    }

    logAudit(db, {
      serverId: null,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_REQUESTED,
      targetType: "user",
      targetId: target.id,
      changes: JSON.stringify({ botId: target.id, requestedByUserId: ctx.userId }),
    })
    broadcastToUserSafe(target.ownerUserId, {
      type: WS_EVENTS.DM_NEW_MESSAGE,
      dmConversationId: dm.id,
      message: {
        id: msg.id,
        authorId: target.id,
        authorName: target.name,
        content: msg.content,
        createdAt: msg.createdAt,
      },
    })
    // 201 — same status code the human path emits on success. Body shape
    // differs (friendship: null + status: "pending") — clients accept both.
    return writeJSON({ friendship: null, status: "pending" }, 201)
  }

  try {
    const result = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: targetUserId,
    })

    if (result.kind === "auto_accepted") {
      // Both sides had pending intents; promoting to accepted is the
      // right behaviour. Notify the other party as if they had accepted
      // an outbound request from us.
      broadcastToUserSafe(targetUserId, {
        type: WS_EVENTS.FRIEND_ACCEPT,
        friendshipId: result.friendship.id,
      })
      return writeJSON(result.friendship, 200)
    }

    // Project explicitly: the DB row's `status` is `string`, but the
    // wire type is the literal `"pending"`; the row also carries columns
    // (`blockerId`, `updatedAt`) that clients don't need.
    const { id, requesterId, addresseeId, createdAt } = result.friendship
    broadcastToUserSafe(targetUserId, {
      type: WS_EVENTS.FRIEND_REQUEST,
      friendship: { id, requesterId, addresseeId, status: "pending" as const, createdAt },
    })
    return writeJSON(result.friendship, 201)
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (err.message === "blocked") return writeError("blocked", 403)
      if (err.message === "already friends") return writeError("already friends", 409)
    }
    if (isUniqueConstraintError(err)) {
      return writeError("friend request already sent", 409)
    }
    throw err
  }
})
