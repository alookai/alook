import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  if (!targetId) return writeError("userId is required", 400)

  const result = await queries.communityFriendship.unblock(db, {
    blockerId: ctx.userId,
    targetId,
  })

  // Unblock is idempotent — no-op if the relationship is already gone.
  return writeJSON({ ok: true, removed: result ?? null })
})
