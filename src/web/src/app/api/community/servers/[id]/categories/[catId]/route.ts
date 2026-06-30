import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  MAX_CATEGORY_NAME_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireServerMember } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const categoryId = ctx.params?.catId
  if (!serverId || !categoryId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value!

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category || category.serverId !== serverId) return writeError("category not found", 404)

  const isAdmin = canManageServer(member.role)
  if (!isAdmin && category.creatorId !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  let body: { name?: string; private?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (body.private !== undefined && !isAdmin) {
    return writeError("only admins can change private setting", 403)
  }

  const changes: { name?: string; private?: boolean } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    if (!trimmed || trimmed.length > MAX_CATEGORY_NAME_LENGTH) {
      return writeError(`name must be 1-${MAX_CATEGORY_NAME_LENGTH} characters`, 400)
    }
    changes.name = trimmed
  }
  if (body.private !== undefined) changes.private = body.private

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  const updated = await queries.communityCategory.updateCategory(db, categoryId, changes)
  if (!updated) return writeError("category not found", 404)

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CATEGORY_UPDATE,
    serverId,
    categoryId,
    changes,
  })

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "category_update",
    targetType: "category",
    targetId: categoryId,
    changes: JSON.stringify(changes),
  })

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const categoryId = ctx.params?.catId
  if (!serverId || !categoryId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value!

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category || category.serverId !== serverId) return writeError("category not found", 404)

  const isAdmin = canManageServer(member.role)
  if (!isAdmin && category.creatorId !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const deleted = await queries.communityCategory.deleteCategory(db, categoryId)
  if (!deleted) return writeError("category not found", 404)

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CATEGORY_DELETE,
    serverId,
    categoryId,
  })

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "category_delete",
    targetType: "category",
    targetId: categoryId,
  })

  return new Response(null, { status: 204 })
})
