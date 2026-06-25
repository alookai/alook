import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const POST = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify user is a member
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  // Owner cannot leave (must delete server instead)
  if (member.role === "owner") {
    return writeError("owner cannot leave the server, delete it instead", 400)
  }

  await queries.communityMember.removeMember(db, member.id)

  fanOutToServerMembers(serverId, {
    type: "community:member.leave",
    serverId,
    userId: ctx.userId,
  }).catch(() => {})

  return new Response(null, { status: 204 })
})
