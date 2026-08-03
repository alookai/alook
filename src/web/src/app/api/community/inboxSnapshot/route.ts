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

  const snapshot = await withD1Retry(
    () => queries.communityAgentInbox.getInboxSnapshotForAgent(db, botUserId),
    { route: "community/inboxSnapshot:snapshot" },
  )
  const rows = await withD1Retry(
    () => queries.communityAgentInbox.toInboxRows(db, snapshot, botUserId),
    { route: "community/inboxSnapshot:rows" },
  )

  return NextResponse.json({
    rows,
    pendingChannels: rows.length,
    pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0),
  })
})
