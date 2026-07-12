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

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const categoryId = ctx.params?.catId
  if (!serverId || !categoryId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category || category.serverId !== serverId) return writeError("category not found", 404)

  // Only the name is mutable. Category privacy (public/private) is fixed at
  // creation — flipping it would silently widen/tighten channel visibility, so
  // `private` is intentionally NOT accepted here (change it by recreating the
  // category). See plans/channel-category-role-permissions.md.
  let body: { name?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    if (!trimmed || trimmed.length > MAX_CATEGORY_NAME_LENGTH) {
      return writeError(`name must be 1-${MAX_CATEGORY_NAME_LENGTH} characters`, 400)
    }
    // Category names are displayed uppercase; store them uppercased so the
    // persisted value matches the client's optimistic rename (which uppercases
    // too) — otherwise the sidebar briefly diverges until the next refetch.
    changes.name = trimmed.toUpperCase()
  }

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  let updated
  try {
    updated = await queries.communityCategory.updateCategory(db, categoryId, changes)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return writeError("a category with this name already exists", 409)
    }
    throw err
  }
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
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const category = await queries.communityCategory.getCategory(db, categoryId)
  if (!category || category.serverId !== serverId) return writeError("category not found", 404)

  // Deleting a non-empty category would `set null` its channels' categoryId,
  // silently re-classifying private channels as public (visible to everyone)
  // while leaving stale channel_member rows. Block it; admin moves/deletes the
  // channels first.
  const hasChannels = await queries.communityCategory.hasChannels(db, categoryId)
  if (hasChannels) {
    return writeError("Move or delete its channels first", 409)
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
