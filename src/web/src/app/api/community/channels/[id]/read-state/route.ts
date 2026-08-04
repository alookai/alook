import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"

/**
 * GET /api/community/channels/:id/read-state
 *
 * Snapshot of the viewer's read pointer for a single channel. Consumed once
 * per channel mount to compute the "New" divider anchor and initial scroll
 * position. Returns `{ null, null }` when the viewer has never visited the
 * channel — the caller treats that as "everything is new, but no divider
 * (start at the bottom)", matching common chat-app first-visit UX.
 *
 * Access via the unified id-in-path gate: 404 for unknown, 403 for non-members
 * (the human split, preserved) — and, when the id is a DM, the DM block gate
 * runs too. That block check is why this route moved off the bare
 * `requireChannelMember`: a blocked-but-still-DM-member could otherwise read a
 * DM's read-state through this channel route (the incidental P0 the trunk
 * closes; the old path only ran the access-member check, never the block).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireMessageSurfaceAccess(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // Wrap in `withD1Retry` on the server so the client can keep `retry: 1`
  // (one retry stack, budget shared with the helper). On exhaust: rethrow —
  // the client `useQuery` rejects, `snapshotRef` never latches a fabricated
  // value, hook returns `{ snapshot: null, isFetching: false }`.
  const row = await withD1Retry(
    () => queries.communityReadState.getReadState(db, {
      userId: ctx.userId,
      channelId,
    }),
    { route: "community/channels/read-state" },
  )

  return writeJSON({
    lastReadMessageId: row?.lastReadMessageId ?? null,
    lastReadAt: row?.lastReadAt ?? null,
    // Seq is the numeric equivalent of the (createdAt, id) pointer — used
    // client-side to compute the `↓ N` unread count without walking the
    // loaded rows (`latestSeq - lastReadSeq`). Falls back to 0 when the
    // viewer has never visited: `latestSeq - 0` = all-messages-are-new,
    // matching what the divider anchor implies.
    lastReadSeq: row?.lastReadSeq ?? 0,
  })
})
