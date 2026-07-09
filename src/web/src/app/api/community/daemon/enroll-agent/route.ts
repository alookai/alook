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
 * runner key (`crk_...`) scoped to (userId, machineId, agentId). The daemon's
 * `CredentialBroker` swaps this runner key in for the agent's per-launch
 * voucher at its local credential proxy, so subprocess CLIs never see it
 * directly — they only reach `/api/community/agent/*` through that proxy.
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

  // Bot enrollment invariant: the target bot must be
  //   user.id = agentId AND isBot AND ownerUserId = ctx.userId AND deletedAt IS NULL
  // AND its binding must point to this machine. Prevents a compromised daemon
  // on machine A from minting a `crk_` for a bot bound to machine B (which
  // would otherwise slip through the old blind-mint path).
  const target = await queries.user.getUserInternal(db, parsed.data.agentId)
  if (
    !target ||
    target.isBot !== true ||
    target.ownerUserId !== ctx.userId ||
    target.deletedAt !== null
  ) {
    return NextResponse.json({ error: "bot not found" }, { status: 404 })
  }
  const binding = await queries.communityBot.getBotBinding(db, parsed.data.agentId)
  if (!binding || binding.machineId !== ctx.machineId) {
    return NextResponse.json({ error: "bot not on this machine" }, { status: 404 })
  }

  const { runnerKey } = await queries.communityMachine.mintAgentRunnerKey(db, {
    userId: ctx.userId,
    machineId: ctx.machineId,
    agentId: parsed.data.agentId,
  })

  const body: CommunityDaemonEnrollAgentResponse = { runnerKey, expiresAt: null }
  return NextResponse.json(body)
})
