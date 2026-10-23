import { NextRequest } from "next/server"
import {
  queries,
  CommunityBotCreateRequestSchema,
  resolveBotCreationConfiguration,
  BotCreationError,
  requiresExplicitModel,
} from "@alook/shared"
import { getDb, getPrimaryDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { completeBotCreation } from "@/lib/community/bot-creation.server"
import { readCommunityBots } from "@/lib/community/bots.server"

export { tokenUsageDayWindow } from "@/lib/community/bots.server"

export const GET = withCommunityActor(async (_req, ctx) => {
  if (ctx.actor.kind === "human") return writeJSON(await readCommunityBots(getDb(ctx.env.DB), ctx.actor.userId))
  const bots = await queries.communityBot.listBotsForOwner(getDb(ctx.env.DB), ctx.actor.ownerUserId)
  return writeJSON({ bots: bots.map((bot) => ({ id: bot.id, handle: `${bot.name}#${bot.discriminator}`, name: bot.name,
    machineId: bot.machineId, backendId: bot.runtime, model: bot.modelName, reasoningEffort: bot.reasoningEffort, isActive: bot.isActive, presence: bot.presence })) })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const [body, err] = await parseBody(req, CommunityBotCreateRequestSchema)
  if (err) return err
  if (requiresExplicitModel(body.runtime) && !body.model?.trim()) {
    return writeError("Choose a model before saving", 400)
  }

  const db = getPrimaryDb(ctx.env.DB)

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
  const modelName = body.model ?? null
  let effortResolution
  try { effortResolution = resolveBotCreationConfiguration(machine, runtime, { backendId: body.runtime, model: modelName, reasoningEffort: body.reasoningEffort ?? null }) }
  catch (error) {
    if (error instanceof BotCreationError) return writeJSON({ error: error.message, code: error.code, ...error.details }, error.status)
    throw error
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

  await completeBotCreation(ctx.env, db, ctx.userId, owner, [{ id: created.botId, name: created.name, discriminator: created.discriminator, description: created.description, machineId: body.machineId }])

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
