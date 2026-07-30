import { NextResponse, type NextRequest } from "next/server"
import { nanoid } from "nanoid"
import {
  queries,
  makeRuntimeConfig,
  resolveModelConfig,
  formatHandle,
  CommunityAgentNapRequestSchema,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { pushAgentNapToMachine } from "@/lib/community/bot-push"

/**
 * POST /api/community/agent/nap — `alook nap --handoff <file>|--text <s>`.
 *
 * Agent-self-initiated session reset. The self-serve twin of the owner
 * `reset-session` route: build the bot's RuntimeConfig → push `agent:nap`
 * (carrying the mandatory handoff) to the bot's OWN machine → on delivery
 * (`sent > 0`) write the `nap` audit row. If the daemon is offline
 * (`sent === 0`) return 409 and write NO audit row — the audit signals a real
 * nap landed at the daemon, not a request. Notifies no one: a nap is the
 * agent's private self-state change.
 *
 * Auth is `withAgentRunnerAuth` (runner key), so the bot acts on ITSELF —
 * `ctx.botUserId`/`ctx.machineId` come from the authenticated runner, not a
 * request field, so an agent can only nap itself.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentNapRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "handoff is required", details: parsed.error.flatten() }, { status: 400 })
  }
  const handoff = parsed.data.handoff

  // Resolve the bot's own wake context (runtime + model) to build the config
  // the daemon needs to respawn a fresh session. `botUserId` is the caller.
  const wakeCtx = await queries.communityBot.getBotWakeContext(db, ctx.botUserId)
  if (wakeCtx.state !== "ready") {
    return NextResponse.json({ error: wakeCtx.state }, { status: 409 })
  }

  const config = makeRuntimeConfig({
    runtime: wakeCtx.runtime,
    model: resolveModelConfig(wakeCtx.runtime, wakeCtx.modelName),
    agentName: wakeCtx.name,
    agentHandle: `@${formatHandle(wakeCtx.name, wakeCtx.discriminator)}`,
  })
  const launchId = nanoid()

  const { sent } = await pushAgentNapToMachine(ctx.env, ctx.machineId, {
    agentId: ctx.botUserId,
    config,
    launchId,
    handoff,
  })
  if (sent === 0) {
    return NextResponse.json(
      { error: "daemon offline — cannot nap right now" },
      { status: 409 },
    )
  }

  // Audit on delivery only (mirrors reset/model-switch). No notification.
  // Stamp lastRefreshContextAt at the SAME chokepoint (single write point),
  // reusing the audit row's own createdAt so the my-bots "last refreshed"
  // indicator can never drift from the nap audit event.
  const inserted = await queries.communityBotAuditLog.insertBotAuditNap(db, { botId: ctx.botUserId })
  if (inserted) {
    await queries.communityBot.touchBotRefreshContext(db, ctx.botUserId, inserted.createdAt)
  }

  return NextResponse.json({ napped: true })
})
