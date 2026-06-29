import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, canManageServer } from "@alook/shared"
import { logAudit } from "@/lib/community/audit"

export const DELETE = withAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) {
    return writeError("invite token is required", 400)
  }

  const db = getDb(ctx.env.DB)

  const invite = await queries.communityInvite.getInviteByToken(db, token)

  if (!invite) {
    return writeError("invite not found", 404)
  }

  const member = await queries.communityMember.getMember(db, invite.serverId, ctx.userId)
  if (!member || !canManageServer(member.role)) {
    return writeError("insufficient permissions", 403)
  }

  await queries.communityInvite.revokeInvite(db, invite.id)

  logAudit(db, {
    serverId: invite.serverId,
    actorId: ctx.userId,
    action: "invite_delete",
    targetType: "invite",
    targetId: invite.id,
  })

  return new Response(null, { status: 204 })
})
