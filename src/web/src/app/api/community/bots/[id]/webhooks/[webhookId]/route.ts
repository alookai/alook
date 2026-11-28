import type { NextRequest } from "next/server"
import {
  BOT_WEBHOOK_PROVIDER_META,
  BotWebhookUpdateSchema,
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
} from "@/lib/community/bot-webhook.server"
import {
  decryptOutboundImCreds,
  deleteTelegramWebhook,
  encryptOutboundImCreds,
  newTelegramSecretToken,
  pushImConfigSyncToMachine,
  registerTelegramWebhook,
  type OutboundImCreds,
} from "@/lib/community/bot-im.server"

export const PATCH = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const [existing, bot] = await Promise.all([
    queries.communityBotWebhook.getBotWebhookById(db, ctx.userId, botId, webhookId),
    queries.communityBot.getBotOwnedBy(db, botId, ctx.userId),
  ])
  if (!existing || !bot) return writeError("webhook not found", 404)

  const [body, parseErr] = await parseBody(req, BotWebhookUpdateSchema)
  if (parseErr) return parseErr

  const meta = BOT_WEBHOOK_PROVIDER_META[existing.provider]
  if (meta.category === "webhook") {
    if (meta.secretMode !== "optional" && body.requireSecret === false) {
      return writeError(`${meta.label} webhooks require a signing secret`, 400)
    }
    if (meta.secretMode === "generated" && body.signingSecret !== undefined) {
      return writeError(`${meta.label} webhooks use a generated signing secret`, 400)
    }
  }

  let newToken: string | undefined
  let newTokenHash: string | undefined
  let returnedSigningSecret: string | null | undefined
  let nextSigningSecretEnc: string | null | undefined
  let hasSigningSecretEnc = false
  let nextOutboundCredsEnc: string | null | undefined
  let hasOutboundCredsEnc = false

  const nextConfig: BotImConfig = { ...existing.config }
  let hasConfig = false
  if (body.accessPolicy !== undefined) {
    nextConfig.accessPolicy = body.accessPolicy
    hasConfig = true
  }
  if (body.allowedSenders !== undefined) {
    nextConfig.allowedSenders = body.allowedSenders
    hasConfig = true
  }
  if (body.requireMentionInGroups !== undefined && meta.supportsGroups) {
    nextConfig.requireMentionInGroups = body.requireMentionInGroups
    hasConfig = true
  }

  if (existing.provider === "telegram") {
    const needReregister = body.botToken !== undefined || body.rotateCredentials === true
    if (needReregister) {
      const existingCreds = await decryptOutboundImCreds(ctx.env, existing.outboundCredsEnc)
      const botToken =
        body.botToken?.trim() ??
        (existingCreds?.platform === "telegram" ? existingCreds.botToken : null)
      if (!botToken) {
        return writeError("Telegram Bot Token is required", 400)
      }
      newToken = newBotWebhookToken()
      newTokenHash = await hashBotWebhookToken(newToken)
      const secretToken = newTelegramSecretToken()
      const registered = await registerTelegramWebhook(
        botToken,
        buildBotWebhookUrl(req, newToken),
        secretToken,
      )
      if (!registered.ok) {
        return writeError(registered.error, 400)
      }
      try {
        nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, secretToken)
        hasSigningSecretEnc = true
        nextOutboundCredsEnc = await encryptOutboundImCreds(ctx.env, {
          platform: "telegram",
          botToken,
        })
        hasOutboundCredsEnc = true
      } catch {
        return writeError("credential encryption service unavailable", 503)
      }
      nextConfig.botUsername = registered.botUsername
      hasConfig = true
    }
  } else if (existing.provider === "feishu") {
    if (body.feishuRegion !== undefined) {
      nextConfig.region = body.feishuRegion
      hasConfig = true
    }
    if (body.feishuAppId !== undefined) {
      nextConfig.feishuAppId = body.feishuAppId
      hasConfig = true
    }
    const updatingCreds =
      body.feishuAppId !== undefined ||
      body.feishuAppSecret !== undefined ||
      body.feishuVerificationToken !== undefined ||
      body.feishuEncryptKey !== undefined
    if (updatingCreds) {
      const existingCreds = await decryptOutboundImCreds(ctx.env, existing.outboundCredsEnc)
      const prevFeishu = existingCreds?.platform === "feishu" ? existingCreds : null
      const appId = body.feishuAppId?.trim() ?? prevFeishu?.appId ?? existing.config.feishuAppId ?? ""
      const appSecret = body.feishuAppSecret?.trim() ?? prevFeishu?.appSecret ?? ""
      if (!appId || !appSecret) {
        return writeError("Feishu App ID and App Secret are required", 400)
      }
      const nextCreds: OutboundImCreds = {
        platform: "feishu",
        appId,
        appSecret,
        verificationToken:
          body.feishuVerificationToken !== undefined
            ? body.feishuVerificationToken.trim() || null
            : (prevFeishu?.verificationToken ?? null),
        encryptKey:
          body.feishuEncryptKey !== undefined
            ? body.feishuEncryptKey.trim() || null
            : (prevFeishu?.encryptKey ?? null),
      }
      try {
        nextOutboundCredsEnc = await encryptOutboundImCreds(ctx.env, nextCreds)
        hasOutboundCredsEnc = true
      } catch {
        return writeError("credential encryption service unavailable", 503)
      }
    }
    if (body.rotateCredentials === true) {
      newToken = newBotWebhookToken()
      newTokenHash = await hashBotWebhookToken(newToken)
      nextConfig.feishuVerifiedAtMs = null
      hasConfig = true
    }
  } else if (existing.provider === "slack") {
    if (body.signingSecret !== undefined) {
      try {
        nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, body.signingSecret)
      } catch {
        return writeError("webhook signing secret service unavailable", 503)
      }
      hasSigningSecretEnc = true
    }
    if (body.botToken !== undefined) {
      const token = body.botToken.trim()
      if (!token.startsWith("xoxb-")) {
        return writeError("Slack Bot User OAuth Token must start with xoxb-", 400)
      }
      try {
        nextOutboundCredsEnc = await encryptOutboundImCreds(ctx.env, {
          platform: "slack",
          botToken: token,
        })
        hasOutboundCredsEnc = true
      } catch {
        return writeError("credential encryption service unavailable", 503)
      }
    }
    if (body.rotateCredentials === true) {
      newToken = newBotWebhookToken()
      newTokenHash = await hashBotWebhookToken(newToken)
    }
  } else if (existing.provider === "wechat") {
    // WeChat credentials live locally on the daemon (0600 file); nothing to encrypt in cloud.
  } else {
    if (body.signingSecret !== undefined) {
      try {
        nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, body.signingSecret)
      } catch {
        return writeError("webhook signing secret service unavailable", 503)
      }
      hasSigningSecretEnc = true
    }

    if (body.rotateCredentials === true) {
      newToken = newBotWebhookToken()
      newTokenHash = await hashBotWebhookToken(newToken)
      if (meta.secretMode === "generated") {
        returnedSigningSecret = newBotWebhookSigningSecret()
        try {
          nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, returnedSigningSecret)
        } catch {
          return writeError("webhook signing secret service unavailable", 503)
        }
        hasSigningSecretEnc = true
      } else if (meta.secretMode === "optional" && body.signingSecret === undefined) {
        const shouldHaveSecret =
          body.requireSecret !== undefined ? body.requireSecret : existing.signingSecretEnc !== null
        if (shouldHaveSecret) {
          returnedSigningSecret = newBotWebhookSigningSecret()
          try {
            nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, returnedSigningSecret)
          } catch {
            return writeError("webhook signing secret service unavailable", 503)
          }
          hasSigningSecretEnc = true
        } else {
          returnedSigningSecret = null
          nextSigningSecretEnc = null
          hasSigningSecretEnc = true
        }
      }
    } else if (meta.secretMode === "optional" && body.requireSecret !== undefined && body.signingSecret === undefined) {
      if (body.requireSecret && existing.signingSecretEnc === null) {
        returnedSigningSecret = newBotWebhookSigningSecret()
        try {
          nextSigningSecretEnc = await encryptBotWebhookSecret(ctx.env, returnedSigningSecret)
        } catch {
          return writeError("webhook signing secret service unavailable", 503)
        }
        hasSigningSecretEnc = true
      } else if (!body.requireSecret && existing.signingSecretEnc !== null) {
        returnedSigningSecret = null
        nextSigningSecretEnc = null
        hasSigningSecretEnc = true
      }
    }
  }

  const updated = await queries.communityBotWebhook.updateBotWebhook(
    db,
    ctx.userId,
    botId,
    webhookId,
    {
      name: body.name,
      enabled: body.enabled,
      eventFilter: body.eventFilter,
      hasEventFilter: body.eventFilter !== undefined,
      instruction: body.instruction,
      tokenHash: newTokenHash,
      signingSecretEnc: nextSigningSecretEnc,
      hasSigningSecretEnc,
      config: hasConfig ? nextConfig : undefined,
      hasConfig,
      outboundCredsEnc: nextOutboundCredsEnc,
      hasOutboundCredsEnc,
    },
  )
  if (!updated) return writeError("webhook not found", 404)

  if (updated.transport === "daemon_poll" && updated.provider === "wechat" && bot.machineId) {
    await pushImConfigSyncToMachine(ctx.env, bot.machineId, {
      type: "im:config_sync",
      botId,
      triggerId: updated.id,
      provider: "wechat",
      action: "upsert",
      enabled: updated.enabled,
      name: updated.name,
      accessPolicy: updated.config.accessPolicy,
      allowedSenders: updated.config.allowedSenders,
      instruction: updated.instruction,
    })
  }

  const [lastDelivery, machine] = await Promise.all([
    queries.communityBotWebhook.getLatestDeliveryForWebhook(db, webhookId),
    bot.machineId
      ? queries.communityMachine.getMachineByIdForUser(db, ctx.userId, bot.machineId)
      : Promise.resolve(null),
  ])
  const payload: {
    webhook: ReturnType<typeof toBotWebhookSummary>
    webhookUrl?: string
    signingSecret?: string | null
  } = {
    webhook: toBotWebhookSummary(updated, lastDelivery, {
      machineName: machine?.displayName || machine?.hostname || null,
      machineOnline: machine ? machine.status === "online" : null,
    }),
  }

  if (newToken !== undefined && updated.provider !== "telegram" && updated.transport === "cloud_webhook") {
    payload.webhookUrl = buildBotWebhookUrl(req, newToken)
    payload.signingSecret = returnedSigningSecret ?? null
  } else if (returnedSigningSecret !== undefined) {
    payload.signingSecret = returnedSigningSecret
  }

  const response = writeJSON(payload)
  if (payload.webhookUrl !== undefined || payload.signingSecret !== undefined) {
    response.headers.set("Cache-Control", "no-store")
  }
  return response
})

export const DELETE = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const [existing, bot] = await Promise.all([
    queries.communityBotWebhook.getBotWebhookById(db, ctx.userId, botId, webhookId),
    queries.communityBot.getBotOwnedBy(db, botId, ctx.userId),
  ])
  if (!existing) return writeError("webhook not found", 404)

  const deleted = await queries.communityBotWebhook.deleteBotWebhook(
    db,
    ctx.userId,
    botId,
    webhookId,
  )
  if (!deleted) return writeError("webhook not found", 404)

  if (existing.provider === "telegram" && existing.outboundCredsEnc) {
    const creds = await decryptOutboundImCreds(ctx.env, existing.outboundCredsEnc)
    if (creds?.platform === "telegram") {
      await deleteTelegramWebhook(creds.botToken)
    }
  } else if (existing.transport === "daemon_poll" && existing.provider === "wechat" && bot?.machineId) {
    await pushImConfigSyncToMachine(ctx.env, bot.machineId, {
      type: "im:config_sync",
      botId,
      triggerId: existing.id,
      provider: "wechat",
      action: "delete",
    })
  }

  return writeJSON({ deleted: true })
})
