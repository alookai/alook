import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

export const PUT = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Two-step check preserves the 404-vs-403 contract that sibling channel
  // routes (pins, threads, PATCH/DELETE) also honor: unknown channel → 404,
  // known channel + non-member → 403. `requireChannelMember` alone collapses
  // both into 403 because the JOIN can't tell the difference.
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Fire all three writes in one D1 batch so partial failure can't leave the
  // inbox inconsistent (mark-read succeeded but the mention/for-you dismissal
  // didn't, or vice versa). D1 batches are atomic per SQLite guarantees.
  await db.batch([
    queries.communityReadState.markChannelReadBuilder(db, {
      userId: ctx.userId,
      channelId,
      lastReadAt: new Date().toISOString(),
    }),
    queries.communityMention.markChannelMentionsReadBuilder(db, ctx.userId, channelId),
    queries.communityInbox.dismissForYouForChannelBuilder(db, ctx.userId, channelId),
  ])

  return writeJSON({ ok: true })
})
