import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { createBotForUser } from "@/lib/community/create-bot.server"
import { withAutomationOrExistingAuth } from "@/lib/automation"
import { readCommunityBots } from "@/lib/community/bots.server"

export { tokenUsageDayWindow } from "@/lib/community/bots.server"

export const GET = withCommunityActor(async (_req, ctx) => {
  if (ctx.actor.kind === "human") return writeJSON(await readCommunityBots(getDb(ctx.env.DB), ctx.actor.userId))
  const bots = await queries.communityBot.listBotsForOwner(getDb(ctx.env.DB), ctx.actor.ownerUserId)
  return writeJSON({ bots: bots.map((bot) => ({ id: bot.id, handle: `${bot.name}#${bot.discriminator}`, name: bot.name,
    machineId: bot.machineId, backendId: bot.runtime, model: bot.modelName, reasoningEffort: bot.reasoningEffort, isActive: bot.isActive, presence: bot.presence })) })
})

export const POST = withAutomationOrExistingAuth("bot.create", createBotForUser, withAuth(createBotForUser))
