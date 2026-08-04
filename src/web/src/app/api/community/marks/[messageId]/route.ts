import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

// Toggle-off: unmark a message for the current user. Self-scoped — deletes only
// ctx.userId's own row; another user's mark on the same message is untouched
// (0-row no-op). Returns ok whether or not a row existed (idempotent).
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.messageId
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)
  await queries.communityMessageMark.unmarkMessage(db, {
    userId: ctx.userId,
    messageId,
  })

  return writeJSON({ ok: true })
})

// Menu-open check: is THIS message marked by the current user? Self-scoped
// (WHERE userId=ctx.userId) — answers "did *I* mark it", never "did anyone",
// so it can't leak another user's private mark state. One-row index lookup.
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.messageId
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)
  const marked = await queries.communityMessageMark.isMessageMarked(
    db,
    ctx.userId,
    messageId,
  )

  return writeJSON({ marked })
})
