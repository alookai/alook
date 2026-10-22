import { queries, type Database } from "@alook/shared"
import { pushBotEventToMachine } from "./bot-push"

export async function completeBotCreation(env: Env, db: Database, ownerId: string, owner: { name: string; discriminator: string }, bots: readonly { id: string; name: string; discriminator: string; description: string; machineId: string }[]) {
  try {
    await queries.communityFriendship.ensureNewSiblingBotFriendships(db, ownerId, bots.map((bot) => bot.id))
  } catch { }
  for (const bot of bots) await pushBotEventToMachine(env, bot.machineId, {
    type: "bot:added", botId: bot.id, name: bot.name, discriminator: bot.discriminator,
    description: bot.description || undefined, ownerName: owner.name, ownerDiscriminator: owner.discriminator,
  })
}

export function botCreationFailure(error: unknown, context: Record<string, unknown> = {}) {
  if (error instanceof queries.communityBotCreation.BotCreationError) return Response.json({ error: error.message, code: error.code, ...error.details, ...context }, { status: error.status })
  throw error
}
