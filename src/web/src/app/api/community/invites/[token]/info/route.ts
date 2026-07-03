import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { serverIconUrl } from "@/lib/community/storage"

// Requires a logged-in caller: invite unfurls used to be public but that
// leaked server metadata to anyone with a token. `withAuth` gates it; the
// invite token remains the accept-side capability.
export const GET = withAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("missing token", 400)

  const db = getDb(ctx.env.DB)

  const invite = await queries.communityInvite.getInviteByToken(db, token)
  if (!invite) return writeError("invite not found or expired", 404)

  const now = new Date().toISOString()
  if (invite.expiresAt && invite.expiresAt <= now) {
    return writeError("invite expired", 410)
  }
  if (invite.maxUses !== null && (invite.uses ?? 0) >= invite.maxUses) {
    return writeError("invite has reached max uses", 410)
  }

  const server = await queries.communityServer.getServer(db, invite.serverId)
  if (!server) return writeError("server not found", 404)

  const memberCount = await queries.communityMember.countMembers(db, invite.serverId)

  return writeJSON({
    serverName: server.name,
    serverIcon: serverIconUrl(server),
    memberCount,
  })
})
