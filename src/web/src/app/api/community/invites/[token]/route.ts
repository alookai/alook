import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"
import { logAudit } from "@/lib/community/audit"
import { requireServerAdmin } from "@/lib/community/permissions"

export const DELETE = withAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("invite token is required", 400)

  const db = getDb(ctx.env.DB)

  // `withD1Retry` (D1-armor: no-fallback read; retry to truth). Drives 404.
  const invite = await withD1Retry(() => queries.communityInvite.getInviteByToken(db, token), {
    route: "invites/revoke/lookup",
  })
  if (!invite) return writeError("invite not found", 404)

  const auth = await requireServerAdmin(db, invite.serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // `withD1Retry` (state 3): revoke is a set-revoked write, idempotent.
  await withD1Retry(() => queries.communityInvite.revokeInvite(db, invite.id), {
    route: "invites/revoke",
  })

  logAudit(db, {
    serverId: invite.serverId,
    actorId: ctx.userId,
    action: "invite_delete",
    targetType: "invite",
    targetId: invite.id,
  })

  return new Response(null, { status: 204 })
})
