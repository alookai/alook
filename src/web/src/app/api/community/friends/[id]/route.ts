import { NextResponse } from "next/server"
import { queries, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const DELETE = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string

  // Hardening — see plans/agent-friendship-approval-gate.md §Hardening.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

  if (!id) {
    return writeError("friendship id is required", 400)
  }

  const friendship = await queries.communityFriendship.getFriendship(db, id)
  if (!friendship) {
    return writeError("friendship not found", 404)
  }

  const isParticipant =
    friendship.requesterId === ctx.userId || friendship.addresseeId === ctx.userId

  if (friendship.status === "accepted") {
    // (a) Either party may remove an accepted friendship.
    if (!isParticipant) {
      return writeError("not a participant in this friendship", 403)
    }
  } else if (friendship.status === "pending") {
    // (b) The requester cancels their own pending. (c) The bot's owner cancels
    // a pending row their bot created. Target-owner deny is NOT here — that path
    // is owner-decision with decision='deny' (one path per role).
    let allowed = friendship.requesterId === ctx.userId
    if (!allowed) {
      const requester = await queries.user.getUserInternal(db, friendship.requesterId)
      if (requester?.isBot && requester.ownerUserId === ctx.userId) allowed = true
    }
    if (!allowed) {
      return writeError("not allowed to cancel this request", 403)
    }
  } else {
    return writeError("friendship is not active", 400)
  }

  // Gated-pending withdrawal: a gating owner is holding an actionable
  // Approve/Deny card. Soft-cancel the row and rehydrate that card to a
  // non-actionable "cancelled" chip — a hard delete would leave the card
  // pointing at a deleted row (clicks 409, card lingers until refetch).
  if (friendship.status === "pending" && friendship.needsOwnerApproval != null) {
    const { row, broadcasts } = await queries.communityFriendship.cancelPendingRequest(db, id)
    if (row) {
      for (const b of broadcasts) broadcastToUserSafe(b.userId, b.event)
    }
    return new NextResponse(null, { status: 204 })
  }

  await queries.communityFriendship.removeFriend(db, id)

  const otherUserId = friendship.requesterId === ctx.userId
    ? friendship.addresseeId
    : friendship.requesterId

  broadcastToUserSafe(otherUserId, {
    type: WS_EVENTS.FRIEND_REMOVE,
    friendshipId: id,
  })

  return new NextResponse(null, { status: 204 })
})
