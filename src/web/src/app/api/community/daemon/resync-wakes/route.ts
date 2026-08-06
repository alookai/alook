import { NextResponse } from "next/server"
import { queries, dispatchOneUnreadWake, withD1Retry } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth"

/**
 * POST /api/community/daemon/resync-wakes
 *
 * Daemon-initiated recovery for the "message sent while the daemon was
 * offline" gap: `WAKE_QUEUE`'s consumer acks (never retries) a wake whose
 * daemon was unreachable at delivery time (`dispatchOneUnreadWake`'s
 * `delivered_nowhere` outcome) — that queue item is gone for good. Rather
 * than the server pushing a catch-up wake on its own when the daemon's WS
 * reconnects, the DAEMON proactively calls this route right after it opens
 * its control-plane connection (`channel.onOpen()`), asking "do any of my
 * bots still have unread work?".
 *
 * This route decides nothing new about addressing/config — for every bot
 * bound to `ctx.machineId` with pending unread, it calls the SAME
 * `dispatchOneUnreadWake` the real `alook-wake-worker` queue consumer uses,
 * which re-reads current D1 state and forwards a freshly built `agent:wake`.
 * Because the daemon's WS just connected, `sendWakeToMachine` finds a live
 * socket this time and delivers immediately.
 */
export const POST = withCommunityDaemonAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const bots = await withD1Retry(
    () => queries.communityBot.listBotsForMachine(db, ctx.machineId),
    { route: "community/daemon/resync-wakes:list-bots" },
  )

  let woken = 0
  for (const bot of bots) {
    const latest = await withD1Retry(
      () => queries.communityAgentInbox.getLatestUnreadMessageForAgent(db, bot.id),
      { route: "community/daemon/resync-wakes:latest-unread" },
    )
    if (!latest) continue
    const result = await dispatchOneUnreadWake(db, ctx.env, { messageId: latest.messageId, botUserId: bot.id })
    if (result.outcome === "sent") woken++
  }

  return NextResponse.json({ woken })
})
