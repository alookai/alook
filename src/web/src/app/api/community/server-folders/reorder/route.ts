import { NextRequest } from "next/server"
import { queries, withD1Retry } from "@alook/shared"
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
  const folderIds = body.folderIds
  const unique = new Set(folderIds)
  if (unique.size !== folderIds.length) {
    return writeError("folderIds must be unique", 400)
  }

  // Reorder query is already user-scoped, but pre-validate ownership so the
  // caller gets an error instead of silent no-ops when an unknown id leaks in.
  const owned = await queries.communityServerFolder.listFolders(db, ctx.userId)
  const ownedIds = new Set(owned.map((f) => f.id))
  const stranger = folderIds.find((id) => !ownedIds.has(id))
  if (stranger) {
    return writeError(`folder ${stranger} not found`, 404)
  }

  // `withD1Retry` (state 3): reorder sets positions to values, idempotent.
  await withD1Retry(() => queries.communityServerFolder.reorderFolders(db, ctx.userId, folderIds), {
    route: "server-folders/reorder",
  })

  return writeJSON({ ok: true })
})
