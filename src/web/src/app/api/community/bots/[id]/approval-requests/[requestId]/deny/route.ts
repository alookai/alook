import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

/**
 * Deny a pending bot approval request. No side effects beyond flipping the
 * row to `denied`. The requester is NOT notified —
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


  return writeJSON({ status: "denied", kind: request.kind })
})
