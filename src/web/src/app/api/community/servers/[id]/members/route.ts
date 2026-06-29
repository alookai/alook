import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify membership
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  const rows = await queries.communityMember.listMembers(db, serverId)
  const members = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.nickname ?? r.userName ?? r.userEmail ?? "Unknown",
    avatar: r.userImage ?? (r.userName ?? "?").charAt(0).toUpperCase(),
    status: (r.userId === ctx.userId ? "online" : "offline") as "online" | "offline",
    sub: "",
    role: r.role ?? "member",
  }))
  return writeJSON({ members })
})
