import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify membership
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  // REST fallback — return all member IDs.
  // Real presence tracking is handled by the WebSocket Durable Object;
  // the client will reconcile actual online state via WS presence events.
  const members = await queries.communityMember.listMembers(db, serverId)
  const memberIds = members.map((m) => m.userId)

  return writeJSON({ memberIds })
})
