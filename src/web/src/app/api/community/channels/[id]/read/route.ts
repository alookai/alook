import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getPrimaryDb } from "@/lib/db"
import { queries, WS_EVENTS, withD1Retry } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"

/**
 * PUT /api/community/channels/:id/read
 *
 * The sole accepted body is the strict object `{ lastReadMessageId: string }`.
 * Every channel type uses the same ordinary `(userId, channelId)` cursor.
 * The server re-reads the canonical target row, rejects an unknown id (404)
 * or a row from another channel (400), and never falls back to the latest row.
 */
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getPrimaryDb(ctx.env.DB)

  // Unified id-in-path access gate: preserves the 404-vs-403 human split
  // (unknown → 404, known non-member → 403) AND, for a DM id, runs the DM block
  // gate — closing the incidental P0 where a blocked-but-still-DM-member could
  // mark a DM read through this bare-channel route (the old path ran only the
  // access-member check, never the block).
  const auth = await withD1Retry(
    () => requireMessageSurfaceAccess(db, channelId, ctx.userId),
    { route: "community/channel-read:access" }
  )
  if (!auth.ok) return writeError(auth.error, auth.status)
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid read target", 400)
  }
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !("lastReadMessageId" in body)
    || typeof body.lastReadMessageId !== "string"
    || body.lastReadMessageId.length === 0
  ) return writeError("invalid read target", 400)
  const lastReadMessageId = body.lastReadMessageId

  const message = await withD1Retry(
    () => queries.communityMessage.getMessage(db, lastReadMessageId),
    { route: "community/channel-read:message" }
  )
  if (!message) return writeError("message not found", 404)
  if (message.channelId !== channelId) {
    const targetAccess = await withD1Retry(
      () => requireMessageSurfaceAccess(db, message.channelId, ctx.userId),
      { route: "community/channel-read:target-access" },
    )
    if (!targetAccess.ok) return writeError(targetAccess.error, targetAccess.status)
    return writeError("message not in channel", 400)
  }
  const target = {
    id: message.id,
    channelId: message.channelId,
    createdAt: message.createdAt,
    seq: message.seq,
  }

  // Fire both writes in one D1 batch so partial failure can't leave the
  // inbox inconsistent (mark-read succeeded but the mention clear didn't, or
  // vice versa). D1 batches are atomic per SQLite guarantees.
  const pointerAdvances = queries.communityReadState.readStateAdvancesCondition(db, {
    userId: ctx.userId,
    channelId,
    targetSeq: target.seq,
  })
  const eligibleMentionChanges = queries.communityMention.unreadChannelMentionThroughSeqCondition(
    db,
    ctx.userId,
    channelId,
    target.seq,
  )
  const results = await withD1Retry(
    () => db.batch([
      queries.communityReadState.advanceReadStateRevisionWhenAnyBuilder(
        db,
        ctx.userId,
        [pointerAdvances, eligibleMentionChanges],
      ),
      queries.communityReadState.markReadToMessageBuilder(db, {
        userId: ctx.userId,
        channelId,
        message: target,
      }),
      queries.communityMention.markChannelMentionsReadBuilder(
        db,
        ctx.userId,
        channelId,
        target.seq,
      ),
      queries.communityReadState.accountReadStateRevisionBuilder(db, ctx.userId),
    ]),
    { route: "community/channel-read:commit" }
  )

  const changed = (results[0] as Array<{ revision: number }>).length > 0
  const revision = (results[3] as Array<{ revision: number }> | undefined)?.[0]?.revision ?? 0

  if (changed) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.READ_STATE_ADVANCED,
      revision,
      inboxChanged: true,
    })
  }

  return writeJSON({ changed, targetSeq: target.seq, revision })
})
