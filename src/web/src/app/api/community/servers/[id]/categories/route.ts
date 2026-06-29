import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, canManageServer } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { name?: string; private?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }

  if (body.private && !canManageServer(member.role)) {
    return writeError("only admins can create private categories", 403)
  }

  const row = await queries.communityCategory.createCategory(db, {
    serverId,
    name: body.name,
    private: body.private,
    creatorId: ctx.userId,
  })

  const category = {
    id: row.id,
    name: row.name,
    position: row.position ?? 0,
    private: !!row.private,
  }

  await fanOutToServerMembers(serverId, {
    type: "community:category.create",
    serverId,
    category,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "category_create",
    targetType: "category",
    targetId: category.id,
  })

  return writeJSON({ category }, 201)
})
