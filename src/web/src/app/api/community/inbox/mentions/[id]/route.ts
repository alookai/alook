import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const DELETE = withAuth(async (_req, ctx) => {
  const mentionId = ctx.params?.id
  if (!mentionId) return writeError("missing mention id", 400)

  const db = getDb(ctx.env.DB)
  const affected = await queries.communityMention.deleteMention(db, ctx.userId, mentionId)
  if (!affected) return writeError("mention not found", 404)

  return writeJSON({ ok: true })
})
