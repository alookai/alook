import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  isUniqueConstraintError,
  MAX_CATEGORY_NAME_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireServerAdmin } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { name?: string; private?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const name = body.name.trim()
  if (!name || name.length > MAX_CATEGORY_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CATEGORY_NAME_LENGTH} characters`, 400)
  }

  // requireServerAdmin above already guarantees admin/owner, so main's
  // per-member private-create check is redundant here. Keep the unique-name
  // 409 wrapper.
  let row
  try {
    row = await queries.communityCategory.createCategory(db, {
      serverId,
      name,
      private: body.private,
      creatorId: ctx.userId,
    })
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return writeError("a category with this name already exists", 409)
    }
    throw err
  }

  const category = {
    id: row.id,
    name: row.name,
    position: row.position ?? 0,
    private: !!row.private,
  }

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CATEGORY_CREATE,
    serverId,
    category,
  })

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "category_create",
    targetType: "category",
    targetId: category.id,
  })

  return writeJSON({ category }, 201)
})
