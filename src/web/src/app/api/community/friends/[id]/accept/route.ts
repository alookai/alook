import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string

  // Hardening — see plans/agent-friendship-approval-gate.md §Hardening.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

  if (!id) {
    return writeError("friendship id is required", 400)
  }

  const friendship = await queries.communityFriendship.getFriendship(db, id)
  if (!friendship) return writeError("friendship not found", 404)
  if (friendship.addresseeId !== ctx.userId) {
    return writeError("only the addressee can accept a friend request", 403)
  }
  // A still-gated incoming row must not be acceptable directly — the requester's
  // owner hasn't unlocked the outbound intent yet (target-consent guardrail).
  if (friendship.needsOwnerApproval !== null) {
    return writeError("owner approval required", 403)
  }

  const result = await queries.communityFriendship.acceptRequest(db, {
    friendshipId: id,
    actorId: ctx.userId,
  })
  if (!result.ok) return writeError("request is not pending", 400)

  for (const b of result.broadcasts) {
    await broadcastToUserSafe(b.userId, b.event)
  }

  return writeJSON(result.friendship)
})
