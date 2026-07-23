import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, isThread, isForumPost } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * Leave a thread/forum-post (remove a participant row). The viewer may remove
 * THEMSELVES; the unit creator may remove anyone. Thread/forum-post only. A
 * later mention/speak re-adds a user who left.
 *
 * (Muting is NOT here — that's the outer channel-header notification level,
 * per-layer, same control a channel uses. Participation is add/leave only.)
 */
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const type = access.value.channel.type
  if (!isThread(type) && !isForumPost(type)) {
    return writeError("not a thread or forum post", 400)
  }

  // Removing another participant is the UNIT creator's call — the person who
  // started the thread/post (`channel.creatorId`), NOT `access.value.isCreator`,
  // which resolves to the parent channel/forum's creator (the access anchor).
  // Any participant may always remove themselves.
  const isSelf = targetUserId === ctx.userId
  const isUnitCreator = access.value.channel.creatorId === ctx.userId
  if (!isSelf && !isUnitCreator) return writeError("forbidden", 403)

  const removed = await queries.communityThread.removeThreadParticipant(db, channelId, targetUserId)
  if (!removed) return writeError("participant not found", 404)
  return new Response(null, { status: 204 })
})
