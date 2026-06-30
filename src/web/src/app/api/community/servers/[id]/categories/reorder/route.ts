import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { requireServerAdmin } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { categoryIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.categoryIds) || body.categoryIds.length === 0) {
    return writeError("categoryIds must be a non-empty array", 400)
  }
  const unique = new Set(body.categoryIds)
  if (unique.size !== body.categoryIds.length) {
    return writeError("categoryIds must be unique", 400)
  }

  const categories = await queries.communityCategory.getCategoriesByIds(db, body.categoryIds)
  if (categories.length !== body.categoryIds.length) {
    return writeError("one or more categories not found", 404)
  }
  if (categories.some((c) => c.serverId !== serverId)) {
    return writeError("category does not belong to this server", 400)
  }

  await queries.communityCategory.reorderCategories(db, serverId, body.categoryIds)

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CATEGORY_REORDER,
    serverId,
    categories: body.categoryIds.map((id, i) => ({ id, position: i })),
  })

  return writeJSON({ ok: true })
})
