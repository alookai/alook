import type { NextRequest } from "next/server"
import { BotImAllowSenderRequestSchema, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withAuth } from "@/lib/middleware/auth-policy"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { toBotWebhookSummary } from "@/lib/community/bot-webhook.server"
import { pushImConfigSyncToMachine } from "@/lib/community/bot-im.server"

export const POST = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const [body, parseErr] = await parseBody(req, BotImAllowSenderRequestSchema)
  if (parseErr) return parseErr

  const result = await queries.communityBotWebhook.allowBotImTriggerSender(
    db,
    ctx.userId,
    botId,
    webhookId,
    body.senderId,
  )
  if (!result.ok) {
    return result.code === "not_found"
      ? writeError("trigger not found", 404)
      : writeError("maximum allowed senders reached", 400)
  }

  if (result.webhook.transport === "daemon_poll" && result.webhook.provider === "wechat" && bot.machineId) {
    await pushImConfigSyncToMachine(ctx.env, bot.machineId, {
      type: "im:config_sync",
      botId,
      triggerId: result.webhook.id,
      provider: "wechat",
      action: "upsert",
      enabled: result.webhook.enabled,
      name: result.webhook.name,
      accessPolicy: result.webhook.config.accessPolicy,
      allowedSenders: result.webhook.config.allowedSenders,
      instruction: result.webhook.instruction,
    })
  }

  const machine = bot.machineId
    ? await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, bot.machineId)
    : null
  const lastDelivery = await queries.communityBotWebhook.getLatestDeliveryForWebhook(db, webhookId)
  return writeJSON({
    webhook: toBotWebhookSummary(result.webhook, lastDelivery, {
      machineName: machine?.displayName || machine?.hostname || null,
      machineOnline: machine ? machine.status === "online" : null,
    }),
    added: result.added,
  })
})
