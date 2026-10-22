import { queries, type Database } from "@alook/shared"
import { pushBotEventToMachine } from "./bot-push"

export async function completeBotCreation(env: Env, db: Database, ownerId: string, owner: { name: string; discriminator: string }, bots: readonly { id: string; name: string; discriminator: string; description: string; machineId: string }[]) {
  try {
    const siblings = await queries.communityBot.listBotsForOwner(db, ownerId)
    const connected = new Set<string>()
    for (const bot of bots) for (const sibling of siblings) {
      const pair = [bot.id, sibling.id].sort().join(":")
      if (sibling.id === bot.id || connected.has(pair)) continue
      connected.add(pair)
      try { await queries.communityFriendship.ensureSiblingBotFriendship(db, { botA: bot.id, botB: sibling.id }) } catch { }
    }
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
