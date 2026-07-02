import { NextResponse } from "next/server"
import {
  queries,
  CommunityDaemonEnrollAgentRequestSchema,
  type CommunityDaemonEnrollAgentResponse,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityDaemonAuth } from "@/lib/middleware/community-daemon-auth"

/**
 * POST /api/community/daemon/enroll-agent
 *
 * Given a valid Bearer `cmk_...` credential, mint (or reuse) a per-agent
 * runner key (`crk_...`) scoped to (userId, machineId, agentId). The daemon
 * uses this via its local credential proxy when it launches subprocess
 * CLIs — v1 has no data-plane consumer yet, but the wire is settled.
 */
export const POST = withCommunityDaemonAuth(async (req, ctx) => {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityDaemonEnrollAgentRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const db = getDb(ctx.env.DB)
  const { runnerKey } = await queries.communityMachine.mintAgentRunnerKey(db, {
    userId: ctx.userId,
    machineId: ctx.machineId,
    agentId: parsed.data.agentId,
  })

  const body: CommunityDaemonEnrollAgentResponse = { runnerKey, expiresAt: null }
  return NextResponse.json(body)
})
