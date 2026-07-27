import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireDMParticipant } from "@/lib/community/permissions"

/**
 * PUT /api/community/dm/:id/read
 *
 * DM twin of `PUT /channels/:id/read`.
 * - Body `{ lastReadMessageId }` present → verify the message lives in this
 *   DM, then align to it.
 * - Body absent / empty → align to the DM's latest message. Empty DM →
 *   no-op (invariant forbids `lastReadMessageId = null` rows).
 */
export const PUT = withCommunityActor(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { lastReadMessageId?: string; seq?: number } = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional
  }

  // Seq form: advance all three read cursors (incl. `lastReadSeq`) to the
  // message at `seq` in this DM. `bumpReadCursor` does its own scope-matched
  // lookup + MAX semantics; null when no such seq exists here.
  if (typeof body.seq === "number" && Number.isFinite(body.seq) && body.seq > 0) {
    const bumped = await queries.communityReadState.bumpReadCursor(db, ctx.userId, { dmConversationId: dmId }, body.seq)
    if (!bumped) return writeError("message not found", 404)
    return writeJSON({ ok: true })
  }

  let target: { id: string; createdAt: string } | null
  if (body.lastReadMessageId) {
    const msg = await queries.communityMessage.getMessage(db, body.lastReadMessageId)
    if (!msg || msg.dmConversationId !== dmId) {
      return writeError("lastReadMessageId does not belong to this dm", 400)
    }
    target = { id: msg.id, createdAt: msg.createdAt }
  } else {
    target = await queries.communityMessage.getLatestMessage(db, { dmConversationId: dmId })
    if (!target) return writeJSON({ ok: true })
  }

  await queries.communityReadState.markReadToMessage(db, {
    userId: ctx.userId,
    dmConversationId: dmId,
    message: target,
  })

  return writeJSON({ ok: true })
})
