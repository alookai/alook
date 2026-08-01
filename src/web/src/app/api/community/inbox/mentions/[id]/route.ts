import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

// `withD1Retry` (D1-armor state 3): delete-by-id is idempotent (re-running
// deletes the same row / affects 0), safe to retry on a transient. The 0-rows
// result maps to 404 as before — a transient is retried, a real miss is not.
export const DELETE = withAuth(async (_req, ctx) => {
  const mentionId = ctx.params?.id
  if (!mentionId) return writeError("missing mention id", 400)

  const db = getDb(ctx.env.DB)
  const affected = await withD1Retry(
    () => queries.communityMention.deleteMention(db, ctx.userId, mentionId),
    { route: "inbox/mentions/delete" },
  )
  if (!affected) return writeError("mention not found", 404)

  return writeJSON({ ok: true })
})
