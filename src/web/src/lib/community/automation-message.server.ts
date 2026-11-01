import type { NextRequest } from "next/server"
import { AutomationMessageSendSchema, COMMUNITY_RESOURCE_CONTRACT_VERSION, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { resolveOwnedBotActor } from "@/lib/middleware/community-agent-runner-auth"
import { handleHumanSend, handleBotSend } from "./message-send.server"

export async function sendAutomationMessage(req: NextRequest, ctx: { env: Env; userId: string; beforeCreate: () => Promise<Response | null> }) {
  const [body, error] = await parseBody(req, AutomationMessageSendSchema)
  if (error) return error
  const db = getPrimaryDb(ctx.env.DB)
  let botId: string | undefined
  if (body.as !== "me") {
    const bot = await queries.automation.getOwnedBotByHandle(db, ctx.userId, body.as.slice(1))
    if (!bot) return writeError("Bot not found", 404)
    const actor = await resolveOwnedBotActor(db, bot.id, ctx.userId)
    if (actor.kind === "error") return actor.response
    botId = actor.actor.botUserId
  }
  const denied = await ctx.beforeCreate()
  if (denied) return denied
  const response = botId ? await handleBotSend(db, botId, ctx.env, { channel: body.target, content: { text: body.content }, nonce: body.nonce })
    : await handleHumanSend(db, ctx.userId, ctx.env, { ref: body.target, createDmIfMissing: true, createThreadIfMissing: true }, { content: body.content, nonce: body.nonce }, COMMUNITY_RESOURCE_CONTRACT_VERSION)
  if (!response.ok) return response
  const result = await response.json() as { state?: string; message: { seq: number | string }; deduped?: boolean; threadId?: string }
  if (result.state === "blocked") return writeJSON(result, response.status)
  const seq = botId ? result.message.seq : `#${result.message.seq}`
  return writeJSON({ state: "sent", seq, deduped: result.deduped === true, ...(result.threadId ? { threadId: result.threadId } : {}) }, response.status)
}
