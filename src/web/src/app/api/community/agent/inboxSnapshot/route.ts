import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

/**
 * POST /api/community/agent/inboxSnapshot — plan §7. Body `{}`.
 * Non-consuming bodiless summary of pending unread, bucketed per channel/DM.
 */
export const POST = withAgentRunnerAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  const snapshot = await queries.communityAgentInbox.getInboxSnapshotForAgent(db, ctx.botUserId)
  const rows = await queries.communityAgentInbox.toInboxRows(db, snapshot, ctx.botUserId)

  return NextResponse.json({
    rows,
    pendingChannels: rows.length,
    pendingMessages: rows.reduce((n, r) => n + r.pendingCount, 0),
  })
})
