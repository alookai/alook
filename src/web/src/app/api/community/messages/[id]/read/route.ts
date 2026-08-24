import { queries, withD1Retry, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const PUT = withAuth(async (_req, ctx) => {
  const openerMessageId = ctx.params?.id
  if (!openerMessageId) return writeError("missing message id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const opener = await withD1Retry(
    () => queries.communityMessage.getMessage(db, openerMessageId),
    { route: "community/forum-opener-read:message" },
  )
  if (!opener) return writeError("message not found", 404)

  const access = await withD1Retry(
    () => requireMessageSurfaceAccess(db, opener.channelId, ctx.userId),
    { route: "community/forum-opener-read:access" },
  )
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.surface !== "channel" || access.value.channel.type !== "forum") {
    return writeError("forum opener required", 409)
  }
  const child = await withD1Retry(
    () => queries.communityChannel.getThreadChannelByParentMessage(
      db,
      opener.channelId,
      openerMessageId,
    ),
    { route: "community/forum-opener-read:child" },
  )
  if (!child || child.type !== "thread" || child.parentMessageId !== openerMessageId) {
    return writeError("forum opener required", 409)
  }

  const needsSparseRead = queries.communityForumOpenerRead.forumOpenerNeedsSparseReadCondition(
    db,
    ctx.userId,
    openerMessageId,
  )
  const unreadMention = queries.communityMention.unreadMessageMentionCondition(
    db,
    ctx.userId,
    openerMessageId,
  )
  const results = await withD1Retry(
    () => db.batch([
      queries.communityReadState.advanceReadStateRevisionWhenAnyBuilder(
        db,
        ctx.userId,
        [needsSparseRead, unreadMention],
      ),
      queries.communityForumOpenerRead.markForumOpenerReadBuilder(db, {
        userId: ctx.userId,
        openerMessageId,
        readAt: new Date().toISOString(),
        condition: needsSparseRead,
      }),
      queries.communityMention.markMessageMentionsReadBuilder(
        db,
        ctx.userId,
        openerMessageId,
      ),
      queries.communityReadState.accountReadStateRevisionBuilder(db, ctx.userId),
    ]),
    { route: "community/forum-opener-read:commit" },
  )
  const changed = (results[0] as Array<{ revision: number }>).length > 0
  const revision = (results[3] as Array<{ revision: number }>)[0]?.revision ?? 0

  if (changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.INBOX_CHANGED,
      revision,
      reason: "forum_opener_read",
      inboxChanged: true,
    })
  }
  return writeJSON({ changed, openerMessageId, revision })
})
