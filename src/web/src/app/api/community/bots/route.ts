import { NextRequest } from "next/server"
import {
  queries,
  CommunityBotCreateRequestSchema,
  COMMUNITY_BOT_LIMIT_PER_OWNER,
  runtimeSupportsModel,
  utcDayKeyDaysAgo,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { pushBotEventToMachine } from "@/lib/community/bot-push"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const bots = await queries.communityBot.listBotsForOwner(db, ctx.userId)
  // Attach each bot's last-30-day activity for the my-bots heatmap. One batched
  // read scoped to the owner's bots (no N+1); bots with no rows default to [].
  // The FE pads missing days to zero cells, so an empty array is the normal
  // new-bot path.
  const sinceDay = utcDayKeyDaysAgo(new Date(), 29)
  const activityByBot = await queries.communityBot.getBotDailyActivityForOwner(
    db,
    ctx.userId,
    sinceDay,
  )
  const withActivity = bots.map((bot) => ({
    ...bot,
    dailyActivity: activityByBot.get(bot.id) ?? [],
  }))
  return writeJSON({ bots: withActivity })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const [body, err] = await parseBody(req, CommunityBotCreateRequestSchema)
  if (err) return err

  const db = getDb(ctx.env.DB)

  // Cap check — anti-abuse floor, not a UX cap.
  const n = await queries.communityBot.countLiveBotsForOwner(db, ctx.userId)
  if (n >= COMMUNITY_BOT_LIMIT_PER_OWNER) {
    return writeError("BOT_LIMIT_REACHED", 409)
  }

  // Machine must be owned by caller AND runtime must be in its availableRuntimes
  // AND currently healthy. Unhealthy runtimes (e.g. broken binary caught by
  // spawn ENOENT and marked by the daemon) are rejected here so a UX picker
  // race doesn't create a bot bound to something that will always fail.
  const machine = await queries.communityBot.getMachineForOwner(
    db,
    body.machineId,
    ctx.userId,
  )
  if (!machine) return writeError("machine not found", 404)
  // getMachineForOwner canonicalizes `availableRuntimes` to include status/lastError
  // via the shared schema, so we can consult status here directly.
  const runtime = machine.availableRuntimes.find((r) => r.id === body.runtime)
  if (!runtime) {
    return writeError(
      `runtime ${body.runtime} not available on this machine`,
      400,
    )
  }
  if (runtime.status === "unhealthy") {
    return writeError(
      `runtime ${body.runtime} is currently unavailable on this machine — check the daemon logs`,
      400,
    )
  }

  // antigravity discards the model at launch; storing an inert value would make
  // the card lie. Reject a non-null model on a runtime that doesn't honor it.
  const modelName = body.model ?? null
  if (modelName !== null && !runtimeSupportsModel(body.runtime)) {
    return writeError(`runtime ${body.runtime} does not support a model selection`, 400)
  }

  const created = await queries.communityBot.createBot(db, {
    ownerId: ctx.userId,
    name: body.name,
    description: body.description,
    machineId: body.machineId,
    runtime: body.runtime,
    image: body.image ?? null,
    modelName,
  })

  // The bot's owner is the authenticated caller — resolve their handle to
  // carry in the bot:added push so the daemon can tell the agent who owns it.
  // The owner MUST resolve: if getUserPublic can't find the authenticated
  // caller we've hit an integrity bug (auth accepted a user id that no longer
  // has a row), and pushing a bot:added with empty owner fields would
  // silently strip the "You are owned by …" privacy paragraph from the
  // agent's system prompt.
  const owner = await queries.user.getUserPublic(db, ctx.userId)
  if (!owner) return writeError("owner not resolvable — retry after re-authenticating", 500)

  // Same-owner sibling auto-friendship fanout. After createBot commits, insert a
  // real accepted community_friendship row for every existing live sibling.
  // Idempotent (ON CONFLICT DO NOTHING) so a concurrent createBot race is
  // absorbed. A per-sibling failure is logged but never fails createBot — the
  // bot exists and is usable; siblings can reconcile via the CLI later. See
  // plans/agent-friendship-approval-gate.md §Bot creation.
  try {
    const siblings = await queries.communityBot.listBotsForOwner(db, ctx.userId)
    for (const sibling of siblings) {
      if (sibling.id === created.botId) continue
      try {
        await queries.communityFriendship.ensureSiblingBotFriendship(db, {
          botA: created.botId,
          botB: sibling.id,
        })
      } catch {}
    }
  } catch {
    // listBotsForOwner failed — the bot is still usable; siblings reconcile
    // via the CLI. Nothing user-visible to fail here.
  }

  // Best-effort WS push — daemon may be offline. Cold-start warmup re-syncs
  // authoritative state on reconnect.
  await pushBotEventToMachine(ctx.env, body.machineId, {
    type: "bot:added",
    botId: created.botId,
    name: created.name,
    discriminator: created.discriminator,
    description: created.description || undefined,
    ownerName: owner.name,
    ownerDiscriminator: owner.discriminator,
  })

  return writeJSON(
    {
      bot: {
        id: created.botId,
        name: created.name,
        description: created.description,
        image: created.image,
        machineId: body.machineId,
        runtime: body.runtime,
        modelName,
      },
    },
    201,
  )
})
