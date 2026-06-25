import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify caller is admin or owner
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  const url = new URL(req.url)
  const action = url.searchParams.get("action") ?? undefined
  const before = url.searchParams.get("before") ?? undefined
  const limitParam = url.searchParams.get("limit")
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : undefined

  const logs = await queries.communityAuditLog.listAuditLog(db, serverId, {
    action,
    before,
    limit,
  })

  return writeJSON({ entries: logs })
})
