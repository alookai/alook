import type { NextRequest } from "next/server"
import { BOT_WEBHOOK_DELIVERY_LIST_DEFAULT, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withAuth } from "@/lib/middleware/auth-policy"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { toBotWebhookDelivery } from "@/lib/community/bot-webhook.server"

export const GET = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
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

  const limitParam = req.nextUrl.searchParams.get("limit")
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : BOT_WEBHOOK_DELIVERY_LIST_DEFAULT
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(50, parsedLimit))
    : BOT_WEBHOOK_DELIVERY_LIST_DEFAULT

  const rows = await queries.communityBotWebhook.listBotWebhookDeliveries(
    db,
    ctx.userId,
    botId,
    webhookId,
    limit,
  )

  return writeJSON({ deliveries: rows.map(toBotWebhookDelivery) })
})
