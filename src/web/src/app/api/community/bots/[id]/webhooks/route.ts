import type { NextRequest } from "next/server"
import {
  BOT_WEBHOOK_GITHUB_DEFAULT_EVENTS,
  BOT_WEBHOOK_MAX_PER_BOT,
  BotWebhookCreateSchema,
  queries,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withAuth } from "@/lib/middleware/auth-policy"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import {
  buildBotWebhookUrl,
  encryptBotWebhookSecret,
  hashBotWebhookToken,
  newBotWebhookSigningSecret,
  newBotWebhookToken,
  toBotWebhookSummary,
} from "@/lib/community/bot-webhook.server"

export const GET = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const db = getPrimaryDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const { webhooks, lastDeliveryByWebhookId } = await queries.communityBotWebhook.listBotWebhooks(
    db,
    ctx.userId,
    botId,
  )

  return writeJSON({
    webhooks: webhooks.map((webhook) =>
      toBotWebhookSummary(webhook, lastDeliveryByWebhookId[webhook.id] ?? null),
    ),
  })
})

export const POST = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const db = getPrimaryDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const [body, parseErr] = await parseBody(req, BotWebhookCreateSchema)
  if (parseErr) return parseErr

  if (body.provider === "github" && body.requireSecret === false) {
    return writeError("GitHub webhooks require a signing secret", 400)
  }

  const wantsSecret = body.provider === "github" || body.requireSecret === true
  const rawToken = newBotWebhookToken()
  const tokenHash = await hashBotWebhookToken(rawToken)
  const signingSecret = wantsSecret ? newBotWebhookSigningSecret() : null

  let signingSecretEnc: string | null = null
  if (signingSecret) {
    try {
      signingSecretEnc = await encryptBotWebhookSecret(ctx.env, signingSecret)
    } catch {
      return writeError("webhook signing secret service unavailable", 503)
    }
  }

  const eventFilter =
    body.eventFilter !== undefined
      ? body.eventFilter
      : body.provider === "github"
        ? [...BOT_WEBHOOK_GITHUB_DEFAULT_EVENTS]
        : null

  const created = await queries.communityBotWebhook.createBotWebhook(db, {
    ownerUserId: ctx.userId,
    botUserId: botId,
    name: body.name,
    provider: body.provider,
    tokenHash,
    signingSecretEnc,
    eventFilter,
    instruction: body.instruction,
  })

  if (!created.ok) {
    return writeError(`maximum of ${BOT_WEBHOOK_MAX_PER_BOT} webhooks per bot reached`, 400)
  }

  const response = writeJSON(
    {
      webhook: toBotWebhookSummary(created.webhook, null),
      webhookUrl: buildBotWebhookUrl(req, rawToken),
      signingSecret,
    },
    201,
  )
  response.headers.set("Cache-Control", "no-store")
  return response
})
