import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * Deny a pending bot approval request. No side effects beyond flipping the
 * row to `denied` and writing an audit row. The requester is NOT notified —
 * they must observe the outcome indirectly (their earlier "Request sent"
 * remains, but no accept event ever arrives).
 */
export const POST = withAuth(async (_req, ctx) => {
  const botId = ctx.params?.id as string
  const requestId = ctx.params?.requestId as string
  const db = getDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const request = await queries.communityBot.getApprovalRequest(db, requestId)
  if (!request || request.botId !== botId) {
    return writeError("approval request not found", 404)
  }
  // Only join_server rows survive migration 0065; anything else 404s defensively.
  if (request.kind !== "join_server") {
    return writeError("approval request not found", 404)
  }
  if (request.status !== "pending") {
    return writeError("request already resolved", 400)
  }

  await queries.communityBot.resolveApprovalRequest(db, requestId, "denied")

  logAudit(db, {
    serverId: request.serverId ?? null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_JOIN_DENIED,
    targetType: "user",
    targetId: botId,
    changes: JSON.stringify({
      botId,
      requestedByUserId: request.requestedByUserId,
      serverId: request.serverId ?? undefined,
    }),
  })

  return writeJSON({ status: "denied", kind: request.kind })
})
