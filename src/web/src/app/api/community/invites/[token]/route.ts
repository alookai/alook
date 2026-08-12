import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireServerAdmin } from "@/lib/community/permissions"

export const DELETE = withAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("invite token is required", 400)

  const db = getDb(ctx.env.DB)

  const invite = await queries.communityInvite.getInviteByToken(db, token)
  if (!invite) return writeError("invite not found", 404)

  const auth = await requireServerAdmin(db, invite.serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  await queries.communityInvite.revokeInvite(db, invite.id)


  return new Response(null, { status: 204 })
})
