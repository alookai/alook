import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isServerOwner, WS_EVENTS } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
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

  await queries.communityMember.removeMember(db, member.id)
  await queries.communityMember.removeOwnerBotsFromServer(db, serverId, botIdsToCascade)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_leave",
    targetType: "member",
    targetId: member.id,
  })
  for (const botId of botIdsToCascade) {
    logAudit(db, {
      serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_REMOVED_FROM_SERVER,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({ botId, serverId, kind: "owner_left_cascade" }),
    })
  }

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId: ctx.userId,
  })
  for (const botId of botIdsToCascade) {
    fanOutToServerMembers(serverId, {
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: botId,
    })
  }

  return new Response(null, { status: 204 })
})
