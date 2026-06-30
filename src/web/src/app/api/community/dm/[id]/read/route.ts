import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import {
  requireDMParticipant,
  requireNotBlocked,
  otherDmParticipant,
} from "@/lib/community/permissions"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // A blocked party can't update read state — that would leak online activity.
  const other = otherDmParticipant(auth.value, ctx.userId)
  const block = await requireNotBlocked(db, ctx.userId, other)
  if (!block.ok) return writeError(block.error, block.status)

  let body: { lastReadMessageId?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional
  }

  if (body.lastReadMessageId) {
    const msg = await queries.communityMessage.getMessage(db, body.lastReadMessageId)
    if (!msg || msg.dmConversationId !== dmId) {
      return writeError("lastReadMessageId does not belong to this dm", 400)
    }
  }

  const result = await queries.communityReadState.markRead(db, {
    userId: ctx.userId,
    dmConversationId: dmId,
    lastReadAt: new Date().toISOString(),
    lastReadMessageId: body.lastReadMessageId,
  })

  return writeJSON(result)
})
