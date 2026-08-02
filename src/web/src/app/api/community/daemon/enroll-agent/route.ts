import { NextResponse } from "next/server"
import {
  queries,
  withD1Retry,
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
  // `withD1Retry` (D1-armor state 2): the bot-ownership + binding checks are the
  // security gate on minting a runner key — a transient would 404 a legitimate
  // enroll (mis-judged state); retry to truth.
  const target = await withD1Retry(() => queries.user.getUserInternal(db, parsed.data.agentId), {
    route: "daemon/enroll-agent/target",
  })
  if (
    !target ||
    target.isBot !== true ||
    target.ownerUserId !== ctx.userId ||
    target.deletedAt !== null
  ) {
    return NextResponse.json({ error: "bot not found" }, { status: 404 })
  }
  const binding = await withD1Retry(
    () => queries.communityBot.getBotBinding(db, parsed.data.agentId),
    { route: "daemon/enroll-agent/binding" },
  )
  if (!binding || binding.machineId !== ctx.machineId) {
    return NextResponse.json({ error: "bot not on this machine" }, { status: 404 })
  }

  // `withD1Retry` (D1-armor state 3): mint is idempotent in effect — it deletes
  // any existing live key for (machine, agent) then inserts one, backed by the
  // partial-unique `(machine_id, agent_id) WHERE revoked_at IS NULL`, so a
  // retried transient always leaves exactly one live key (rotating the bearer),
  // never two.
  const { runnerKey } = await withD1Retry(
    () =>
      queries.communityMachine.mintAgentRunnerKey(db, {
        userId: ctx.userId,
        machineId: ctx.machineId,
        agentId: parsed.data.agentId,
      }),
    { route: "daemon/enroll-agent/mint-key" },
  )

  const body: CommunityDaemonEnrollAgentResponse = { runnerKey, expiresAt: null }
  return NextResponse.json(body)
})
