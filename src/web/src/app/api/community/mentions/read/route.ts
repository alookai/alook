import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  let body: { messageIds?: string[]; all?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const db = getDb(ctx.env.DB)

  if (body.all) {
    await queries.communityMention.markAllMentionsRead(db, ctx.userId)
  } else if (Array.isArray(body.messageIds) && body.messageIds.length > 0) {
    await queries.communityMention.markMentionsRead(db, ctx.userId, body.messageIds)
  } else {
    return writeError("provide messageIds array or set all: true", 400)
  }

  return writeJSON({ ok: true })
})
