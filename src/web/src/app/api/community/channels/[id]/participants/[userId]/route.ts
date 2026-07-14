import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * Leave a thread (remove a participant row). The viewer may remove THEMSELVES;
 * the thread creator may remove anyone. Thread-only. A later mention/speak
 * re-adds a user who left.
 *
 * (Muting a thread is NOT here — that's the outer channel-header notification
 * level, per-layer, same control a channel uses. Participation is add/leave
 * only.)
 */
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.channel.type !== "thread") return writeError("not a thread", 400)

  const isSelf = targetUserId === ctx.userId
  if (!isSelf && !access.value.isCreator) return writeError("forbidden", 403)

  const removed = await queries.communityThread.removeThreadParticipant(db, channelId, targetUserId)
  if (!removed) return writeError("participant not found", 404)
  return new Response(null, { status: 204 })
})
