import { NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth"

/**
 * GET /api/community/daemon/bots
 *
 * Returns the bots bound to THIS machine (scope is machineId, not userId —
 * a user may own bots across multiple machines, but each daemon only cares
 * about its own). Response shape is minimal — `id`, `name`, `discriminator`,
 * `description` — for the daemon's `botsById` cache and system-prompt
 * assembly (`name`+`discriminator` pair into the bot's global handle). No
 * avatar (display-only, server does that).
 */
export const GET = withCommunityDaemonAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const bots = await queries.communityBot.listBotsForMachine(db, ctx.machineId)
  return NextResponse.json({ bots })
})
