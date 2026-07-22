import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * Requester-side cancel of a pending bot friend-request. Mirror of the owner's
 * `deny` but authorized by `requestedByUserId === ctx.userId` — the requester
 * withdraws their own outgoing request. Flipping the row out of `pending`
 * frees the partial unique index so the requester can send again later.
 */
export const POST = withAuth(async (_req, ctx) => {
  const requestId = ctx.params?.requestId as string
  const db = getDb(ctx.env.DB)

  const request = await queries.communityBot.getApprovalRequest(db, requestId)
  if (!request || request.kind !== "friend") {
    return writeError("friend request not found", 404)
  }
  if (request.requestedByUserId !== ctx.userId) {
    return writeError("friend request not found", 404)
  }
  if (request.status !== "pending") {
    return writeError("request already resolved", 400)
  }

  await queries.communityBot.resolveApprovalRequest(db, requestId, "denied")

  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_CANCELLED,
    targetType: "user",
    targetId: request.botId,
    changes: JSON.stringify({ botId: request.botId, requestedByUserId: ctx.userId }),
  })

  return writeJSON({ status: "cancelled" })
})
