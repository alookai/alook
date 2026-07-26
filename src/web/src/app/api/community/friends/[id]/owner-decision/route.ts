import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * POST /api/community/friends/[id]/owner-decision — body `{ decision }`. The
 * bot owner approves or denies a gated friend row via their DM card.
 * Dispatches to `ownerDecideOnRow`, which encapsulates all four cases.
 * See plans/agent-friendship-approval-gate.md §Owner decision endpoint.
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string

  // The deciding owner is human by definition; keep the invariant testable.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

  if (!id) return writeError("friendship id is required", 400)

  let body: { decision?: unknown }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (body.decision !== "approve" && body.decision !== "deny") {
    return writeError("decision must be 'approve' or 'deny'", 400)
  }

  const result = await queries.communityFriendship.ownerDecideOnRow(db, {
    friendshipId: id,
    actorId: ctx.userId,
    decision: body.decision,
  })
  if (!result.ok) {
    if (result.reason === "forbidden") return writeError("forbidden", 403)
    return writeError("already_resolved", 409)
  }

  for (const b of result.broadcasts) {
    await broadcastToUserSafe(b.userId, b.event)
  }

  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action:
      body.decision === "approve"
        ? COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_APPROVED_BY_OWNER
        : COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_DENIED_BY_OWNER,
    targetType: "friendship",
    targetId: id,
    changes: JSON.stringify({ friendshipId: id, decision: body.decision }),
  })

  return writeJSON({ status: result.friendship.status, friendshipId: id })
})
