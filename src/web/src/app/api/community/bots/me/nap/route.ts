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
import { withCommunityActor, requireBot } from "@/lib/middleware/community-actor"
import { pushAgentNapToMachine } from "@/lib/community/bot-push"

/**
 * POST /api/community/bots/me/nap — `alook nap --handoff <file>`.
 *
 * Relocated from the flat /api/community/nap (route/disc 接口树统一, Gener #215
 * 乙; Blondie #527 placement). nap is a BOT-QUA-BOT self lifecycle action — the
 * agent resets its OWN session — so it lives under the bots/me/* family
 * (self-scope, "me" = the credential-authenticated bot, NO target id), the same
 * "me = credential actor" model users/me/* uses (a bot hits POST
 * users/me/inbox/pull for its own inbox). This is DISTINCT from:
 *   - bots/{id}/* (owner MANAGES an owned bot: reset-session/approval/audit —
 *     withAuth + getBotOwnedBy, owner→bot[id]); nap is bot→self, opposite auth.
 *   - users/me/* (an actor's USER-scoped resources: inbox/marks — human+bot both
 *     have a user row); nap is bot-qua-bot lifecycle, only a bot has a session.
 * bots/me/* family invariant (same as users/me #426): self-scope, credential =
 * identity, NO target-bot/target-user param, "me" never proxies another bot.
 *
 * Bot-only, human actor → 403 via requireBot (Gener #116). `botUserId`/
 * `machineId` come from the authenticated runner (gate.bot), NEVER a request
 * field, so an agent can only nap ITSELF — a single self-reset, not a batch and
 * not a nap of any other bot.
 *
 * The flat /api/community/nap route is deleted (flat-delete step) — this door
 * is the sole canonical entry; the deploy-orchestration verify-list gates
 * deleting it on the daemon being confirmed on this new target.
 *
 * Agent-self-initiated session reset. The self-serve twin of the owner
 * `bots/{id}/reset-session` route: build the bot's RuntimeConfig → push
 * `agent:nap` (carrying the mandatory handoff) to the bot's OWN machine → on
 * delivery (`sent > 0`) the daemon writes the `nap` audit row at reborn-ready.
 * If the daemon is offline (`sent === 0`) return 409 and write NO audit row —
 * the audit signals a real nap landed, not a request. Notifies no one: a nap is
 * the agent's private self-state change.
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
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
    return NextResponse.json({ error: "handoff is required", details: parsed.error.flatten() }, { status: 400 })
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
    model: resolveModelConfig(wakeCtx.runtime, wakeCtx.modelName),
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

  // The `nap` audit row + awake-time stamp are NOT written here: they are
  // re-homed to the daemon completion signal (the `agent_session` frame at
  // reborn-ready), so the record reflects "the nap actually completed" rather
  // than "the command was dispatched." See plans/reset-nap-completion-rehome.md.

  return NextResponse.json({ napped: true })
})
