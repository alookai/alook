import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const DELETE = withAuth(async (_req, ctx) => {
  const inviteId = ctx.params?.id
  if (!inviteId) {
    return writeError("invite id is required", 400)
  }

  const db = getDb(ctx.env.DB)

  // Fetch invite to get serverId for permission check
  const invite = await queries.communityInvite.getInvite(db, inviteId)

  if (!invite) {
    return writeError("invite not found", 404)
  }

  // Verify caller is admin or owner of the server
  const member = await queries.communityMember.getMember(db, invite.serverId, ctx.userId)
  if (!member || (member.role !== "admin" && member.role !== "owner")) {
    return writeError("insufficient permissions", 403)
  }

  await queries.communityInvite.revokeInvite(db, inviteId)

  await queries.communityAuditLog.logAction(db, {
    serverId: invite.serverId,
    actorId: ctx.userId,
    action: "invite_delete",
    targetType: "invite",
    targetId: inviteId,
  })

  return new Response(null, { status: 204 })
})
