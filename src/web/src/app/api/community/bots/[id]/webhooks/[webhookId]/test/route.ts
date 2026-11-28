import type { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import { buildBotWebhookEventPrompt, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withAuth } from "@/lib/middleware/auth-policy"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import {
  dispatchBotWebhookDelivery,
  toBotWebhookDelivery,
} from "@/lib/community/bot-webhook.server"

export const POST = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const webhook = await queries.communityBotWebhook.getBotWebhookById(
    db,
    ctx.userId,
    botId,
    webhookId,
  )
  if (!webhook) return writeError("webhook not found", 404)

  const deliveryId = `whd_${nanoid(16)}`
  const promptText = buildBotWebhookEventPrompt({
    webhookName: webhook.name,
    provider: webhook.provider,
    eventType: "test",
    deliveryId,
    instruction: webhook.instruction,
    payloadText: `Owner-triggered test notification for webhook "${webhook.name}". No external action is required.`,
  })

  const { delivery } = await queries.communityBotWebhook.createBotWebhookDelivery(db, {
    id: deliveryId,
    webhookId: webhook.id,
    ownerUserId: webhook.ownerUserId,
    botUserId: webhook.botUserId,
    externalDeliveryId: null,
    eventType: "test",
    summary: `Test notification for ${webhook.name}`,
    promptText,
    status: "pending",
  })

  const dispatched = await dispatchBotWebhookDelivery(db, ctx.env, delivery)
  return writeJSON({ delivery: toBotWebhookDelivery(dispatched.delivery) })
})
