import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { replaceForumTagsForActor } from "@/lib/community/forum-tag-operations"

/** Replace the tag set on a forum opener message. */
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  const db = getDb(ctx.env.DB)
  const result = await replaceForumTagsForActor(db, {
    messageId,
    userId: ctx.userId,
    tags: raw && typeof raw === "object" ? (raw as { tags?: unknown }).tags : undefined,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ tags: result.value.tags })
})
