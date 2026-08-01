import { NextRequest } from "next/server"
import { queries, withD1Retry, parseNameAndTag, isBlocked } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireNotBlocked } from "@/lib/community/permissions"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  // Belt-and-suspenders: bot sessions never reach here (auth.ts:204 rejects
  // them), but a future auth regression must not let a bot author friend-graph
  // state. See plans/agent-friendship-approval-gate.md §Hardening.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

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
  // treats it as a no-op.
  if (target.isBot === true && target.ownerUserId === ctx.userId) {
    return writeError("already friends", 409)
  }

  const block = await requireNotBlocked(db, ctx.userId, targetUserId)
  if (!block.ok) return writeError(block.error, block.status)

  try {
    // `withD1Retry` (state 3): sendRequest is get-first (findActive) + backed by
    // the `uq_friendship_active` unique index — a response-lost retry finds the
    // existing row, and a concurrent double-insert hits the unique constraint,
    // so it can't create a duplicate. Domain errors (blocked / already-friends /
    // already-sent) aren't in the retry whitelist, so withD1Retry rethrows them
    // straight into the catch below, unchanged.
    const result = await withD1Retry(
      () =>
        queries.communityFriendship.sendRequest(db, {
          requesterId: ctx.userId,
          addresseeId: targetUserId,
        }),
      { route: "friends/request" },
    )
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
