import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * PUT /api/community/threads/:id/read
 *
 * Same two-shape contract as `PUT /channels/:id/read` (a thread is a channel):
 * - Body `{ lastReadMessageId }` present → scope-check + align to that
 *   message.
 * - Body absent / empty → align to the thread's latest message. Empty thread
 *   → no-op (invariant forbids `lastReadMessageId = null` rows).
 */
export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing id", 400)

  const db = getDb(ctx.env.DB)

  // Two-step check preserves the 404-vs-403 contract that sibling channel
  // routes (pins, threads, PATCH/DELETE) also honor: unknown channel → 404,
  // known channel + non-member → 403. `requireChannelMember` alone collapses
  // both into 403 because the JOIN can't tell the difference.
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { lastReadMessageId?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional
  }

  let target: { id: string; createdAt: string } | null
  if (body.lastReadMessageId) {
    const msg = await queries.communityMessage.getMessage(db, body.lastReadMessageId)
    if (!msg) return writeError("message not found", 404)
    if (msg.channelId !== channelId) {
      return writeError("message not in channel", 400)
    }
    target = { id: msg.id, createdAt: msg.createdAt }
  } else {
    target = await queries.communityMessage.getLatestMessage(db, { channelId })
    if (!target) return writeJSON({ ok: true })
  }

  await queries.communityReadState.markReadToMessage(db, {
    userId: ctx.userId,
    channelId,
    message: target,
  })

  return writeJSON({ ok: true })
})
