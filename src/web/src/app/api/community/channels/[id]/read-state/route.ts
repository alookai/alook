import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * GET /api/community/channels/:id/read-state
 *
 * Snapshot of the viewer's read pointer for a single channel. Consumed once
 * per channel mount to compute the "New" divider anchor and initial scroll
 * position. Returns `{ null, null }` when the viewer has never visited the
 * channel — the caller treats that as "everything is new, but no divider
 * (start at the bottom)", matching common chat-app first-visit UX.
 *
 * Contract mirrors the sibling `read` route: 404 for unknown channels, 403
 * for non-members. The two-step check preserves that ordering (unknown →
 * 404, known-but-not-a-member → 403); `requireChannelMember` alone collapses
 * both into 403.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const row = await queries.communityReadState.getReadState(db, {
    userId: ctx.userId,
    channelId,
  })

  return writeJSON({
    lastReadMessageId: row?.lastReadMessageId ?? null,
    lastReadAt: row?.lastReadAt ?? null,
  })
})
