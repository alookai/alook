import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isServerOwner, WS_EVENTS } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
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

  await queries.communityMember.removeMember(db, member.id)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_leave",
    targetType: "member",
    targetId: member.id,
  })

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId: ctx.userId,
  })

  return new Response(null, { status: 204 })
})
