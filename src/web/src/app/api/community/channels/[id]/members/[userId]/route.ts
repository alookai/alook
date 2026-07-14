import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * Remove a member from a private access unit (channel or forum post).
 *   - Self-leave: any member may remove THEMSELVES (drop their own access).
 *   - Remove others: CREATOR only (add is open to members, but evicting someone
 *     else is the creator's call; admins have no content privilege here).
 *   - The creator can never be removed OR self-leave (they own the unit).
 * The removed user gets a CHANNEL_MEMBER_REMOVE so their sidebar drops the
 * channel + evicts its caches.
 */
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const channel = access.value.channel
  if (channel.creatorId === targetUserId) {
    // Covers both "creator can't be removed" and "creator can't leave".
    return writeError("can't remove the channel creator", 400)
  }
  // Self-leave is always allowed; removing anyone else is creator-only.
  const isSelf = targetUserId === ctx.userId
  if (!isSelf && !access.value.isCreator) return writeError("forbidden", 403)

  const removed = await queries.communityChannel.deleteChannelMember(db, channelId, targetUserId)
  if (!removed) return writeError("member not found", 404)

  const event = {
    type: WS_EVENTS.CHANNEL_MEMBER_REMOVE,
    serverId: channel.serverId,
    channelId,
    userId: targetUserId,
  } as const
  // Notify the removed user (drop the channel) plus the remaining audience.
  const recipients = await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
  await Promise.all(
    [...new Set([...recipients, targetUserId])].map((uid) => broadcastToUserSafe(uid, event))
  )

  logAudit(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "channel_member_remove",
    targetType: "channel",
    targetId: channelId,
    changes: JSON.stringify({ userId: targetUserId }),
  })

  return new Response(null, { status: 204 })
})
