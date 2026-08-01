import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"

/**
 * POST /api/community/inboxSnapshot — plan §7. Body `{}`.
 * Non-consuming bodiless summary of pending unread, bucketed per channel/DM.
 *
 * Moved from /agent (plan §4 MOVE, §9 phase 3); bot-only, human actor → 403 via requireBot (Gener #116).
 */
export const POST = withCommunityActor(async (_req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId } = gate.bot

  const db = getDb(ctx.env.DB)

  // `withD1Retry`, NOT `readOrStale` (D1-armor state 2, state-misleading read):
  // this is the agent's pending-unread view — a stale snapshot would report the
  // wrong unread count/buckets and mislead the agent's wake/read decisions (same
  // read-model red line as a zombie/phantom unread). No downstream authoritative
  // re-read backs this response, so it must retry to the true value rather than
  // silently degrade to stale. Both reads wrapped as one unit.
  const rows = await withD1Retry(
    async () => {
      const snapshot = await queries.communityAgentInbox.getInboxSnapshotForAgent(db, botUserId)
      return queries.communityAgentInbox.toInboxRows(db, snapshot, botUserId)
    },
    { route: "inboxSnapshot" },
  )

  return NextResponse.json({
    rows,
    pendingChannels: rows.length,
    pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0),
  })
})
