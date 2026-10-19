import { NextRequest } from "next/server"
import {
  queries,
  CommunityBotCreateRequestSchema,
  resolveReasoningEffort,
  requiresExplicitModel,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { pushBotEventToMachine } from "@/lib/community/bot-push"
import { readCommunityBots } from "@/lib/community/bots.server"

export { tokenUsageDayWindow } from "@/lib/community/bots.server"

export const GET = withAuth(async (_req, ctx) => writeJSON(await readCommunityBots(getDb(ctx.env.DB), ctx.userId)))

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const [body, err] = await parseBody(req, CommunityBotCreateRequestSchema)
  if (err) return err
  if (requiresExplicitModel(body.runtime) && !body.model?.trim()) {
    return writeError("Choose a model before saving", 400)
  }

  const db = getDb(ctx.env.DB)

  let capacity = await queries.productPlan.getBotCapacitySummary(db, ctx.userId)
  if (capacity.ownedCount >= capacity.limit) {
    return writeJSON({
      error: "BOT_LIMIT_REACHED",
      plan: capacity.plan.id,
      planDisplayName: capacity.plan.displayName,
      limit: capacity.limit,
      ownedCount: capacity.ownedCount,
      activeCount: capacity.activeCount,
    }, 409)
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

  const modelName = body.model ?? null
  const effort = body.reasoningEffort ?? null
  const effortResolution = resolveReasoningEffort(runtime, modelName, effort)
  if (effort !== null && !effortResolution.supported) {
    return writeError(`reasoning effort ${effort} is not supported by this runtime/model`, 400)
  }

  let created: Awaited<ReturnType<typeof queries.communityBot.createBot>>
  try {
    created = await queries.communityBot.createBot(db, {
      ownerId: ctx.userId,
      name: body.name,
      description: body.description,
      machineId: body.machineId,
      runtime: body.runtime,
      image: body.image ?? null,
      modelName,
      reasoningEffort: effortResolution.canonicalEffort,
    })
  } catch (error) {
    if (!queries.communityBot.isBotEntitlementLimitError(error)) throw error
    capacity = await queries.productPlan.getBotCapacitySummary(db, ctx.userId)
    return writeJSON({
      error: "BOT_LIMIT_REACHED",
      plan: capacity.plan.id,
      planDisplayName: capacity.plan.displayName,
      limit: capacity.limit,
      ownedCount: capacity.ownedCount,
      activeCount: capacity.activeCount,
    }, 409)
  }

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
  // absorbed. A per-sibling failure never fails createBot — the
  // bot exists and is usable; siblings can reconcile via the CLI later.
  try {
    const siblings = await queries.communityBot.listBotsForOwner(db, ctx.userId)
    for (const sibling of siblings) {
      if (sibling.id === created.botId) continue
      try {
        await queries.communityFriendship.ensureSiblingBotFriendship(db, {
          botA: created.botId,
          botB: sibling.id,
        })
      } catch (err) {
        void err
      }
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
        discriminator: created.discriminator,
        description: created.description,
        image: created.image,
        avatarVersion: 0,
        machineId: body.machineId,
        runtime: body.runtime,
        modelName,
        reasoningEffort: effortResolution.canonicalEffort,
        runtimeConfigRevision: 0,
        isActive: true,
      },
    },
    201,
  )
})
