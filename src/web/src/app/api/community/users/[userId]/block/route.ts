import { queries, withD1Retry, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  // Hardening — see plans/agent-friendship-approval-gate.md §Hardening.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

  if (!targetId) return writeError("userId is required", 400)
  if (targetId === ctx.userId) return writeError("cannot block yourself", 400)

  const target = await withD1Retry(() => queries.user.getUserPublic(db, targetId), {
    route: "users/block/target",
  })
  if (!target) return writeError("user not found", 404)

  // `withD1Retry` (D1-armor state 3, idempotent write): block is set-to-blocked
  // (re-running lands the same blocked state), safe to retry on a transient.
  const result = await withD1Retry(
    () =>
      queries.communityFriendship.block(db, {
        blockerId: ctx.userId,
        targetId,
      }),
    { route: "users/block" },
  )

  broadcastToUserSafe(targetId, {
    type: WS_EVENTS.FRIEND_BLOCK,
    userId: ctx.userId,
  })

  // If blocking tore down an existing accepted friendship, tell the other
  // side so their friend list reflects it.
  if (result.removedFriendshipId) {
    broadcastToUserSafe(targetId, {
      type: WS_EVENTS.FRIEND_REMOVE,
      friendshipId: result.removedFriendshipId,
    })
  }

  // Rehydrate any approval card referencing a pending row this block
  // soft-cancelled — an owner's Approve/Deny card or a J2 "waiting on
  // <addressee>" chip → a non-actionable "cancelled" chip.
  for (const b of result.broadcasts) broadcastToUserSafe(b.userId, b.event)

  return writeJSON(result.row)
})
