import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireDMParticipant } from "@/lib/community/permissions"

/**
 * GET /api/community/dm/:id/read-state
 *
 * DM twin of `GET /channels/:id/read-state`. Snapshot of the viewer's read
 * pointer for a single DM. Consumed once per DM mount to compute the "New"
 * divider anchor and initial scroll position. Returns `{ null, null, 0 }`
 * when the viewer has never opened the DM — the caller treats that as
 * "everything is new, but no divider (start at the bottom)", matching common
 * chat-app first-visit UX.
 *
 * `requireDMParticipant` handles both unknown-DM and non-participant cases
 * (returns 403 for either — the DM permission helper deliberately collapses
 * them, unlike the channel route which surfaces a 404 for unknown ids).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const row = await queries.communityReadState.getReadState(db, {
    userId: ctx.userId,
    dmConversationId: dmId,
  })

  return writeJSON({
    lastReadMessageId: row?.lastReadMessageId ?? null,
    lastReadAt: row?.lastReadAt ?? null,
    // Seq is the numeric equivalent of the (createdAt, id) pointer — used
    // client-side to compute the `↓ N` unread count without walking the
    // loaded rows (`latestSeq - lastReadSeq`). Falls back to 0 when the
    // viewer has never visited: `latestSeq - 0` = all-messages-are-new,
    // matching what the divider anchor implies.
    lastReadSeq: row?.lastReadSeq ?? 0,
  })
})
