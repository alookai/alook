import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

// Toggle-on: mark a message for the current user. Self-scoped — the mark row is
// always keyed to ctx.userId, never a body-supplied id. Idempotent: a re-mark
// hits UNIQUE(userId, messageId) and no-ops (markMessage uses
// onConflictDoNothing), so the client can call it without a 409 dance.
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { channelId?: string; messageId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (!body.messageId) return writeError("missing messageId", 400)
  if (!body.channelId) return writeError("missing channelId", 400)

  // You can only mark a message you can see — gate on channel membership.
  const auth = await requireChannelMember(db, body.channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // The target message must belong to the channel the caller claims — prevents
  // marking a message via a channel the caller can see but the message isn't in.
  const target = await queries.communityMessage.getMessage(db, body.messageId)
  if (!target || target.channelId !== body.channelId) {
    return writeError("message not found", 404)
  }

  await queries.communityMessageMark.markMessage(db, {
    userId: ctx.userId,
    channelId: body.channelId,
    messageId: body.messageId,
  })

  return writeJSON({ ok: true })
})
