import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const targetId = ctx.params?.userId as string

  // Hardening — see plans/agent-friendship-approval-gate.md §Hardening.
  if (ctx.user?.isBot) return writeError("forbidden", 403)

  if (!targetId) return writeError("userId is required", 400)

  // `withD1Retry` (D1-armor state 3): unblock is idempotent (no-op if already
  // gone, per below), safe to retry on a transient.
  const result = await withD1Retry(
    () =>
      queries.communityFriendship.unblock(db, {
        blockerId: ctx.userId,
        targetId,
      }),
    { route: "users/unblock" },
  )

  // Unblock is idempotent — no-op if the relationship is already gone.
  return writeJSON({ ok: true, removed: result ?? null })
})
