import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * GET /api/community/channels/:id/messages/seq/:seq
 *
 * Resolve a seq number to its message ID within a channel. Used for message
 * ref jumping: when the user clicks #123 and that message isn't loaded, we
 * need its ID to trigger an anchor fetch.
 *
 * Returns: { id: string } | { error: "not_found" }
 */
export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const seqStr = ctx.params?.seq
  if (typeof channelId !== "string" || typeof seqStr !== "string") {
    return writeJSON({ error: "invalid_params" }, 400)
  }

  const seq = parseInt(seqStr, 10)
  if (isNaN(seq) || seq <= 0) {
    return writeJSON({ error: "invalid_seq" }, 400)
  }

  const db = getDb(ctx.env.DB)

  // Permission check: user must have access to this channel
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // `withD1Retry` (D1-armor: no-fallback message-by-seq read; retry to truth).
  const message = await withD1Retry(
    () => queries.communityMessage.getMessageByChannelAndSeq(db, { channelId }, seq),
    { route: "channels/messages/seq" },
  )
  if (!message) {
    return writeJSON({ error: "not_found" }, 404)
  }

  return writeJSON({ id: message.id })
})
