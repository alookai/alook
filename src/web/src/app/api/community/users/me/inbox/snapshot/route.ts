import { NextResponse, type NextRequest } from "next/server"
import { queries, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"

/**
 * GET /api/community/users/me/inbox/snapshot — a non-consuming, bodiless summary
 * of the caller's pending unread, bucketed per channel/DM (route/disc trunk,
 * 接口树统一 轴3; folds the flat `inboxSnapshot` verb into the users/me resource).
 * A GET (pure peek — it NEVER advances the read waterline, unlike pull), so the
 * fetch↔advance decoupling is preserved (Aigneis #41: snapshot=peek, pull=fetch,
 * ack=advance).
 *
 * Bot-only (human actor → 403). ⭐ users/me/* family invariant (Aigneis #426):
 * scope is the caller's own userId (`gate.bot.userId`), NO target-user param —
 * a bot only ever sees its own inbox summary.
 */
export const GET = withCommunityActor(async (_req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId } = gate.bot

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
