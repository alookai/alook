import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const categoryId = ctx.params?.catId
  if (!serverId || !categoryId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category) return writeError("category not found", 404)

  // Admin/owner can edit any; others can only edit their own
  const isAdmin = member.role === "owner" || member.role === "admin"
  if (!isAdmin && category.creatorId !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  let body: { name?: string; private?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // Only admin/owner can toggle private
  if (body.private !== undefined && !isAdmin) {
    return writeError("only admins can change private setting", 403)
  }

  const changes: { name?: string; private?: boolean } = {}
  if (body.name !== undefined) changes.name = body.name
  if (body.private !== undefined) changes.private = body.private

  const updated = await queries.communityCategory.updateCategory(db, categoryId, changes)
  if (!updated) return writeError("category not found", 404)

  await fanOutToServerMembers(serverId, {
    type: "community:category.update",
    serverId,
    categoryId,
    changes,
  })

  await queries.communityAuditLog.logAction(db, {
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

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category) return writeError("category not found", 404)

  // Admin/owner can delete any; others can only delete their own
  const isAdmin = member.role === "owner" || member.role === "admin"
  if (!isAdmin && category.creatorId !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const deleted = await queries.communityCategory.deleteCategory(db, categoryId)
  if (!deleted) return writeError("category not found", 404)

  await fanOutToServerMembers(serverId, {
    type: "community:category.delete",
    serverId,
    categoryId,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "category_delete",
    targetType: "category",
    targetId: categoryId,
  })

  return new Response(null, { status: 204 })
})
