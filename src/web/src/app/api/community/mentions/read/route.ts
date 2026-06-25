import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  let body: { messageIds: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.messageIds) || body.messageIds.length === 0) {
    return writeError("messageIds must be a non-empty array", 400)
  }

  const db = getDb(ctx.env.DB)
  await queries.communityMention.markMentionsRead(db, ctx.userId, body.messageIds)

  return writeJSON({ ok: true })
})
