import type { NextRequest } from "next/server"
import {
  BOT_WEBHOOK_MAX_PER_BOT,
  BOT_WEBHOOK_PROVIDER_META,
  BotWebhookCreateSchema,
  DEFAULT_BOT_IM_CONFIG,
  queries,
  type BotImConfig,
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
  type BotTriggerMachineContext,
} from "@/lib/community/bot-webhook.server"
import {
  encryptOutboundImCreds,
  newTelegramSecretToken,
  pushImConfigSyncToMachine,
  registerTelegramWebhook,
  type OutboundImCreds,
} from "@/lib/community/bot-im.server"

async function getBotMachineContext(
  db: ReturnType<typeof getPrimaryDb>,
  ownerUserId: string,
  machineId: string | null | undefined,
): Promise<BotTriggerMachineContext> {
  if (!machineId) return { machineName: null, machineOnline: null }
  const machine = await queries.communityMachine.getMachineByIdForUser(db, ownerUserId, machineId)
  if (!machine) return { machineName: null, machineOnline: null }
  return {
    machineName: machine.displayName || machine.hostname || null,
    machineOnline: machine.status === "online",
  }
}

export const GET = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const db = getPrimaryDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const [{ webhooks, lastDeliveryByWebhookId }, machineContext] = await Promise.all([
    queries.communityBotWebhook.listBotWebhooks(db, ctx.userId, botId),
    getBotMachineContext(db, ctx.userId, bot.machineId),
  ])

  return writeJSON({
    webhooks: webhooks.map((webhook) =>
      toBotWebhookSummary(webhook, lastDeliveryByWebhookId[webhook.id] ?? null, machineContext),
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
  if (meta.category === "webhook") {
    if (meta.secretMode !== "optional" && body.requireSecret === false) {
      return writeError(`${meta.label} webhooks require a signing secret`, 400)
    }
    if (meta.secretMode === "generated" && body.signingSecret !== undefined) {
      return writeError(`${meta.label} webhooks use a generated signing secret`, 400)
    }
  }

  const rawToken = newBotWebhookToken()
  const tokenHash = await hashBotWebhookToken(rawToken)
  const webhookUrl = meta.transport === "cloud_webhook" ? buildBotWebhookUrl(req, rawToken) : undefined

  let returnedSigningSecret: string | null = null
  let secretToEncrypt: string | null = null
  let outboundCreds: OutboundImCreds | null = null
  const config: BotImConfig = {
    ...DEFAULT_BOT_IM_CONFIG,
    accessPolicy: body.accessPolicy ?? "allowlist",
    allowedSenders: body.allowedSenders ?? [],
    requireMentionInGroups:
      meta.supportsGroups ? (body.requireMentionInGroups ?? true) : false,
  }

  if (body.provider === "telegram") {
    const botToken = body.botToken?.trim()
    if (!botToken) {
      return writeError("Telegram Bot Token is required", 400)
    }
    const secretToken = newTelegramSecretToken()
    const registered = await registerTelegramWebhook(botToken, webhookUrl!, secretToken)
    if (!registered.ok) {
      return writeError(registered.error, 400)
    }
    secretToEncrypt = secretToken
    outboundCreds = { platform: "telegram", botToken }
    config.botUsername = registered.botUsername
  } else if (body.provider === "feishu") {
    const appId = body.feishuAppId?.trim()
    const appSecret = body.feishuAppSecret?.trim()
    if (!appId || !appSecret) {
      return writeError("Feishu App ID and App Secret are required", 400)
    }
    config.region = body.feishuRegion ?? "cn"
    config.feishuAppId = appId
    outboundCreds = {
      platform: "feishu",
      appId,
      appSecret,
      verificationToken: body.feishuVerificationToken?.trim() || null,
      encryptKey: body.feishuEncryptKey?.trim() || null,
    }
  } else if (body.provider === "slack") {
    const signingSecret = body.signingSecret?.trim()
    const botToken = body.botToken?.trim()
    if (!signingSecret) {
      return writeError("Slack Signing Secret is required", 400)
    }
    if (!botToken || !botToken.startsWith("xoxb-")) {
      return writeError("Slack Bot User OAuth Token (xoxb-...) is required", 400)
    }
    secretToEncrypt = signingSecret
    outboundCreds = { platform: "slack", botToken }
  } else if (body.provider === "wechat") {
    config.daemonStatus = "scan_required"
    config.requireMentionInGroups = false
  } else if (meta.secretMode === "generated") {
    returnedSigningSecret = newBotWebhookSigningSecret()
    secretToEncrypt = returnedSigningSecret
  } else if (meta.secretMode === "external") {
    if (body.signingSecret !== undefined) {
      secretToEncrypt = body.signingSecret
    }
  } else if (meta.secretMode === "optional") {
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

  let outboundCredsEnc: string | null = null
  if (outboundCreds) {
    try {
      outboundCredsEnc = await encryptOutboundImCreds(ctx.env, outboundCreds)
    } catch {
      return writeError("credential encryption service unavailable", 503)
    }
  }

  const created = await queries.communityBotWebhook.createBotWebhook(db, {
    ownerUserId: ctx.userId,
    botUserId: botId,
    name: body.name,
    provider: body.provider,
    category: meta.category,
    transport: meta.transport,
    tokenHash,
    signingSecretEnc,
    config: meta.category === "im" ? config : null,
    outboundCredsEnc,
    eventFilter: body.eventFilter ?? null,
    instruction: body.instruction,
  })

  if (!created.ok) {
    return writeError(`maximum of ${BOT_WEBHOOK_MAX_PER_BOT} webhooks per bot reached`, 400)
  }

  if (created.webhook.transport === "daemon_poll" && created.webhook.provider === "wechat" && bot.machineId) {
    await pushImConfigSyncToMachine(ctx.env, bot.machineId, {
      type: "im:config_sync",
      botId,
      triggerId: created.webhook.id,
      provider: "wechat",
      action: "upsert",
      enabled: created.webhook.enabled,
      name: created.webhook.name,
      accessPolicy: created.webhook.config.accessPolicy,
      allowedSenders: created.webhook.config.allowedSenders,
      instruction: created.webhook.instruction,
    })
  }

  const machineContext = await getBotMachineContext(db, ctx.userId, bot.machineId)
  const response = writeJSON(
    {
      webhook: toBotWebhookSummary(created.webhook, null, machineContext),
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      signingSecret: returnedSigningSecret,
    },
    201,
  )
  response.headers.set("Cache-Control", "no-store")
  return response
})
