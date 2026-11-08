import { withAuth } from "@/lib/middleware/auth-policy"
import { flattenError } from "zod"
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
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { pushAgentNapToMachine } from "@/lib/community/bot-push"

/**
 * A bot can reset only its own session. Bot and machine identity come from
 * the authenticated runner, never request fields. Human actors are denied.
 */
export const POST = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const { userId: botUserId, machineId } = gate.bot

  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentNapRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid nap request", details: flattenError(parsed.error) }, { status: 400 })
  }
  const handoff = parsed.data.handoff

  // Resolve the bot's own wake context (runtime + model) to build the config
  // the daemon needs to respawn a fresh session. `botUserId` is the caller.
  const wakeCtx = await queries.communityBot.getBotWakeContext(db, botUserId)
  if (wakeCtx.state !== "ready") {
    return NextResponse.json({ error: wakeCtx.state }, { status: 409 })
  }

  const config = makeRuntimeConfig({
    runtime: wakeCtx.runtime,
    model: resolveModelConfig(wakeCtx.modelName),
    reasoningEffort: wakeCtx.reasoningEffort ?? undefined,
    runtimeConfigRevision: wakeCtx.runtimeConfigRevision,
    agentName: wakeCtx.name,
    agentHandle: `@${formatHandle(wakeCtx.name, wakeCtx.discriminator)}`,
  })
  const launchId = nanoid()

  const { sent } = await pushAgentNapToMachine(ctx.env, machineId, {
    agentId: botUserId,
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

  return NextResponse.json({ napped: true })
})
