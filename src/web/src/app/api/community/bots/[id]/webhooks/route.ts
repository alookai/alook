import type { NextRequest } from "next/server"
import {
  BOT_WEBHOOK_MAX_PER_BOT,
  BOT_WEBHOOK_PROVIDER_META,
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

  const meta = BOT_WEBHOOK_PROVIDER_META[body.provider]
  if (meta.secretMode !== "optional" && body.requireSecret === false) {
    return writeError(`${meta.label} webhooks require a signing secret`, 400)
  }
  if (meta.secretMode === "generated" && body.signingSecret !== undefined) {
    return writeError(`${meta.label} webhooks use a generated signing secret`, 400)
  }

  const rawToken = newBotWebhookToken()
  const tokenHash = await hashBotWebhookToken(rawToken)

  let returnedSigningSecret: string | null = null
  let secretToEncrypt: string | null = null

  if (meta.secretMode === "generated") {
    returnedSigningSecret = newBotWebhookSigningSecret()
    secretToEncrypt = returnedSigningSecret
  } else if (meta.secretMode === "external") {
    if (body.signingSecret !== undefined) {
      secretToEncrypt = body.signingSecret
    }
  } else {
    if (body.signingSecret !== undefined) {
      secretToEncrypt = body.signingSecret
    } else if (body.requireSecret === true) {
      returnedSigningSecret = newBotWebhookSigningSecret()
      secretToEncrypt = returnedSigningSecret
    }
  }

  let signingSecretEnc: string | null = null
  if (secretToEncrypt) {
    try {
      signingSecretEnc = await encryptBotWebhookSecret(ctx.env, secretToEncrypt)
    } catch {
      return writeError("webhook signing secret service unavailable", 503)
    }
  }

  const created = await queries.communityBotWebhook.createBotWebhook(db, {
    ownerUserId: ctx.userId,
    botUserId: botId,
    name: body.name,
    provider: body.provider,
    tokenHash,
    signingSecretEnc,
    eventFilter: body.eventFilter ?? null,
    instruction: body.instruction,
  })

  if (!created.ok) {
    return writeError(`maximum of ${BOT_WEBHOOK_MAX_PER_BOT} webhooks per bot reached`, 400)
  }

  const response = writeJSON(
    {
      webhook: toBotWebhookSummary(created.webhook, null),
      webhookUrl: buildBotWebhookUrl(req, rawToken),
      signingSecret: returnedSigningSecret,
    },
    201,
  )
  response.headers.set("Cache-Control", "no-store")
  return response
})
