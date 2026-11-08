import { withAuth } from "@/lib/middleware/auth-policy"
import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"

/**
 * Bot-only, self-scoped unread summary. Fetching it never advances read state.
 */
export const GET = withAuth(communityActorPolicy({ allowInactiveBot: true }), async (_req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId, isActive } = gate.bot

  // Match the consuming pull door: inactive bots expose no inbox state and do
  // not pay the visibility/aggregation/hydration query cost. Runner auth
  // already loaded the binding state, avoiding a second D1 read on every poll.
  if (!isActive) {
    return NextResponse.json({ rows: [], pendingChannels: 0, pendingMessages: 0 })
  }

  const db = getDb(ctx.env.DB)

  const snapshot = await withD1Retry(
    () => queries.communityAgentInbox.getInboxSnapshotForAgent(db, botUserId),
    { route: "community/users/me/inbox/snapshot:snapshot" },
  )
  const rows = await withD1Retry(
    () => queries.communityAgentInbox.toInboxRows(db, snapshot, botUserId),
    { route: "community/users/me/inbox/snapshot:rows" },
  )

  return NextResponse.json({
    rows,
    pendingChannels: rows.length,
    pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0),
  })
})
