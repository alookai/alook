import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const folderId = ctx.params?.id
  if (!folderId) return writeError("missing folder id", 400)

  const db = getDb(ctx.env.DB)

  // Verify ownership
  const folder = await queries.communityServerFolder.getFolder(db, folderId, ctx.userId)
  if (!folder) return writeError("folder not found", 404)

  let body: { name?: string; serverIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return writeError("name must be a non-empty string", 400)
    }
    await queries.communityServerFolder.updateFolder(db, folderId, { name: body.name.trim() })
  }

  if (body.serverIds !== undefined) {
    await queries.communityServerFolder.replaceFolderItems(db, folderId, body.serverIds)
  }

  // Return updated folder
  const updated = await queries.communityServerFolder.getFolder(db, folderId, ctx.userId)
  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const folderId = ctx.params?.id
  if (!folderId) return writeError("missing folder id", 400)

  const db = getDb(ctx.env.DB)

  // Verify ownership
  const folder = await queries.communityServerFolder.getFolder(db, folderId, ctx.userId)
  if (!folder) return writeError("folder not found", 404)

  await queries.communityServerFolder.deleteFolder(db, folderId)

  return new Response(null, { status: 204 })
})
