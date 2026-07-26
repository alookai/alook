import { queries, WS_EVENTS } from "@alook/shared"
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
  // Either side of a pending request can tear it down (addressee rejecting,
  // requester cancelling). The DB query is atomic on `status='pending'`.
  if (friendship.requesterId !== ctx.userId && friendship.addresseeId !== ctx.userId) {
    return writeError("not a participant in this friend request", 403)
  }
  // Symmetric with accept: a still-gated incoming row can't be rejected via a
  // direct API call — the addressee can't yet see it (target-consent guardrail).
  if (friendship.needsOwnerApproval !== null) {
    return writeError("owner approval required", 403)
  }

  const { row, broadcasts } = await queries.communityFriendship.rejectRequest(db, id)
  if (!row) return writeError("request is not pending", 400)

  const otherUserId = friendship.requesterId === ctx.userId
    ? friendship.addresseeId
    : friendship.requesterId
  broadcastToUserSafe(otherUserId, {
    type: WS_EVENTS.FRIEND_REJECT,
    friendshipId: id,
  })
  // Rehydrate any owner-approval card referencing this row (J2: the owner
  // approved, then the human addressee rejected → card flips to "Denied").
  for (const b of broadcasts) broadcastToUserSafe(b.userId, b.event)

  return writeJSON({ ok: true })
})
