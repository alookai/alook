import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  await queries.communityMention.markAllMentionsRead(db, ctx.userId)
  return writeJSON({ ok: true })
})
