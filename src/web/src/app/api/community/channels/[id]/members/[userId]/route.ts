import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * Remove a member from a private-category channel. Only creator/admins
 * (canManage) may remove, and the channel creator can never be removed (they
 * always retain access). The removed user gets a CHANNEL_MEMBER_REMOVE so
 * their sidebar drops the channel + evicts its caches.
 */
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (!access.value.canManage) return writeError("forbidden", 403)

  const channel = access.value.channel
  if (channel.creatorId === targetUserId) {
    return writeError("can't remove the channel creator", 400)
  }

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
