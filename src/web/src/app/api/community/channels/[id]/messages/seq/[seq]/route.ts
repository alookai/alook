import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

/**
 * GET /api/community/channels/:id/messages/seq/:seq
 *
 * Resolve a seq number to its message ID within a channel. Used for message
 * ref jumping: when the user clicks #123 and that message isn't loaded, we
 * need its ID to trigger an anchor fetch. Also the folded `resolve` bot verb's
 * seq→id lookup.
 *
 * Dual-actor door (route/disc trunk — message-keyed faces): withCommunityActor
 * serves human (session) + bot (crk_). Authorization goes through the SINGLE
 * requireMessageSurfaceAccess entry (no standalone requireChannelMember) keyed
 * on `ctx.actor.userId`, so a DM's seq is gated by requireDMAccess (incl block)
 * and a bot passes the same mask — same §3/①-C as the messages door.
 *
 * Returns: { id: string } | { error: "not_found" }
 */
export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
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

  // Single authorization entry (dispatch by surface, DM block incl); no
  // standalone requireChannelMember (§3). A nonexistent/unreachable channel
  // opaque-404s here before the seq lookup.
  const access = await requireMessageSurfaceAccess(db, channelId, ctx.actor.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const message = await queries.communityMessage.getMessageByChannelAndSeq(db, { channelId }, seq)
  if (!message) {
    return writeJSON({ error: "not_found" }, 404)
  }

  return writeJSON({ id: message.id })
})
