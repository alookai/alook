import { NextRequest } from "next/server"
import { queries, MAX_FOLDER_NAME_LENGTH } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const folders = await queries.communityServerFolder.listFolders(db, ctx.userId)
  return writeJSON({ folders })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { name: string; serverIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return writeError("name must be a non-empty string", 400)
  }
  const name = body.name.trim()
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return writeError(`name must be ≤ ${MAX_FOLDER_NAME_LENGTH} characters`, 400)
  }

  if (body.serverIds !== undefined) {
    if (!Array.isArray(body.serverIds)) {
      return writeError("serverIds must be an array", 400)
    }
    if (body.serverIds.length > 0) {
      const memberServerIds = new Set(
        await queries.communityMember.listMemberServerIds(db, ctx.userId),
      )
      const stranger = body.serverIds.find((id) => !memberServerIds.has(id))
      if (stranger) {
        return writeError(`not a member of server ${stranger}`, 400)
      }
    }
  }

  const folder = await queries.communityServerFolder.createFolder(db, {
    userId: ctx.userId,
    name,
    serverIds: body.serverIds,
  })

  return writeJSON(folder, 201)
})
