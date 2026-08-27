import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isServerOwner, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe, fanOutToServerMembers } from "@/lib/community/fanout"
import { requireServerMember } from "@/lib/community/permissions"

export const POST = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify user is a member
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value

  // Owner cannot leave (must delete server instead)
  if (isServerOwner(member.role)) {
    return writeError("owner cannot leave the server, delete it instead", 400)
  }

  // Owner-leaves-server cascade: their live bots that are members of this
  // server are removed too. See §Owner-leaves-server cascade in plan.
  const botIdsToCascade = await queries.communityMember.listOwnerBotsInServer(
    db,
    serverId,
    ctx.userId,
  )

  const removed = await queries.communityMember.removeMemberAndOwnerBots(
    db,
    member.id,
    serverId,
    ctx.userId,
    botIdsToCascade,
  )
  if (!removed) return writeError("member not found", 404)

  const viewerLeaveEvent = {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId: ctx.userId,
  } as const
  const botLeaveEvents = botIdsToCascade.map((botId) => ({
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: botId,
  } as const))

  await Promise.all([
    fanOutToServerMembers(serverId, viewerLeaveEvent),
    broadcastToUserSafe(ctx.userId, viewerLeaveEvent),
    ...botLeaveEvents.flatMap((event) => [
      fanOutToServerMembers(serverId, event),
      broadcastToUserSafe(event.userId, event),
    ]),
  ])

  return new Response(null, { status: 204 })
})
