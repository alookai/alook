import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { folderIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.folderIds) || body.folderIds.length === 0) {
    return writeError("folderIds must be a non-empty array", 400)
  }
  const unique = new Set(body.folderIds)
  if (unique.size !== body.folderIds.length) {
    return writeError("folderIds must be unique", 400)
  }

  // Reorder query is already user-scoped, but pre-validate ownership so the
  // caller gets an error instead of silent no-ops when an unknown id leaks in.
  const owned = await queries.communityServerFolder.listFolders(db, ctx.userId)
  const ownedIds = new Set(owned.map((f) => f.id))
  const stranger = body.folderIds.find((id) => !ownedIds.has(id))
  if (stranger) {
    return writeError(`folder ${stranger} not found`, 404)
  }

  await queries.communityServerFolder.reorderFolders(db, ctx.userId, body.folderIds)

  return writeJSON({ ok: true })
})
