import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * Message-keyed mark door (route/disc trunk 接口树统一, marks relocation, Melly
 * #420): a mark is a mutation ON a message → message-keyed, self-scoped (the row
 * is always keyed to ctx.userId, never a body-supplied id). Folds the former
 * flat `marks` verbs:
 *   - PUT    → toggle-on  (was POST /marks)
 *   - DELETE → toggle-off (was DELETE /marks/{messageId})
 *   - GET    → is-this-marked-by-me (was GET /marks/{messageId})
 * The cross-channel "my marks list" aggregate is a user-scoped read and lives at
 * GET users/me/marks (relocated separately). Bodies are byte-identical to the
 * former routes; only the addressing moved (messageId flat→path).
 */

// Toggle-on: mark a message for the current user. Idempotent — a re-mark hits
// UNIQUE(userId, messageId) and no-ops (markMessage uses onConflictDoNothing),
// so the client can call it without a 409 dance.
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)

  let body: { channelId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (!body.channelId) return writeError("missing channelId", 400)

  // You can only mark a message you can see — gate on channel membership.
  const auth = await requireChannelMember(db, body.channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // The target message must belong to the channel the caller claims — prevents
  // marking a message via a channel the caller can see but the message isn't in.
  const target = await queries.communityMessage.getMessage(db, messageId)
  if (!target || target.channelId !== body.channelId) {
    return writeError("message not found", 404)
  }

  await queries.communityMessageMark.markMessage(db, {
    userId: ctx.userId,
    channelId: body.channelId,
    messageId,
  })

  return writeJSON({ ok: true })
})

// Toggle-off: unmark a message for the current user. Self-scoped — deletes only
// ctx.userId's own row; another user's mark on the same message is untouched
// (0-row no-op). Returns ok whether or not a row existed (idempotent).
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
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
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)
  const marked = await queries.communityMessageMark.isMessageMarked(
    db,
    ctx.userId,
    messageId,
  )

  return writeJSON({ marked })
})
