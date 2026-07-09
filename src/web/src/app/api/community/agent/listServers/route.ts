import { NextResponse, type NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"

/**
 * POST /api/community/agent/listServers — plan §7. Body `{}`. Which
 * servers/workspaces the bot participates in. Never includes `ownerUserId`.
 */
export const POST = withAgentRunnerAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityServer.listUserServers(db, ctx.botUserId)
  const servers = rows.map((s) => ({ id: s.id, name: s.name }))
  return NextResponse.json({ servers })
})
