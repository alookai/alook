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

  await queries.communityServerFolder.reorderFolders(db, ctx.userId, body.folderIds)

  return writeJSON({ ok: true })
})
