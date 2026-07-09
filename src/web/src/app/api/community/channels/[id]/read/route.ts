import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * PUT /api/community/channels/:id/read
 *
 * Marks the channel read for the current viewer. Two shapes:
 * - Body omitted or `{}` → mass mark-read. Server picks the latest message
 *   in the channel and writes both `lastReadAt = msg.createdAt` and
 *   `lastReadMessageId = msg.id`. Empty channels are a no-op — no row
 *   written — because the read-state invariant forbids
 *   `lastReadMessageId = null` rows.
 * - Body `{ lastReadMessageId }` → Slack-style progressive mark-read.
 *   Verifies the message exists AND belongs to this channel, then writes
 *   the message's `createdAt` + `id` as the new pointer. Rejects when the
 *   message belongs to another channel (400) — protects against confused-
 *   deputy watermark advances.
 *
 * The body key matches DM (`PUT /dm/:id/read`) and thread
 * (`PUT /threads/:id/read`) — all three routes accept `lastReadMessageId`.
 *
 * Mention clear still fires in one D1 batch on non-empty channels. On an
 * empty channel we short-circuit before writing anything — there are no
 * mentions to clear on a channel with no messages.
 */
export const PUT = withAuth(async (req: NextRequest, ctx) => {
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

  // Parse the body — best-effort. An empty body is legal (mass mark-read).
  let lastReadMessageId: string | undefined
  try {
    // A truly empty body throws in `req.json()`; catch and treat as `{}`.
    const raw = await req.text()
    if (raw.trim().length > 0) {
      const body = JSON.parse(raw) as { lastReadMessageId?: unknown }
      if (typeof body?.lastReadMessageId === "string" && body.lastReadMessageId.length > 0) {
        lastReadMessageId = body.lastReadMessageId
      }
    }
  } catch {
    // Malformed JSON — fall through with `lastReadMessageId` unset. The mass
    // mark-read semantics are the safe fallback.
  }

  // Resolve the target message. Both branches align (lastReadAt, lastReadMessageId)
  // to a real message — that's the read-state invariant.
  let target: { id: string; createdAt: string } | null
  if (lastReadMessageId) {
    const msg = await queries.communityMessage.getMessage(db, lastReadMessageId)
    if (!msg) return writeError("message not found", 404)
    // Scope check — a message from another channel MUST NOT advance THIS
    // channel's watermark.
    if (msg.channelId !== channelId) {
      return writeError("message not in channel", 400)
    }
    target = { id: msg.id, createdAt: msg.createdAt }
  } else {
    target = await queries.communityMessage.getLatestMessage(db, { channelId })
    // Empty channel: no row can be written under the invariant. Nothing to
    // clear either (mentions/for-you require messages to exist first), so
    // short-circuit with a successful no-op.
    if (!target) return writeJSON({ ok: true })
  }

  // Fire both writes in one D1 batch so partial failure can't leave the
  // inbox inconsistent (mark-read succeeded but the mention clear didn't, or
  // vice versa). D1 batches are atomic per SQLite guarantees.
  await db.batch([
    queries.communityReadState.markReadToMessageBuilder(db, {
      userId: ctx.userId,
      channelId,
      message: target,
    }),
    queries.communityMention.markChannelMentionsReadBuilder(db, ctx.userId, channelId),
  ])

  return writeJSON({ ok: true })
})
