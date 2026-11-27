import type { NextRequest } from "next/server"
import { BOT_WEBHOOK_PROVIDER_META, BotWebhookUpdateSchema, queries } from "@alook/shared"
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

export const PATCH = withAuth(humanAuthPolicy, async (req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const existing = await queries.communityBotWebhook.getBotWebhookById(
    db,
    ctx.userId,
    botId,
    webhookId,
  )
  if (!existing) return writeError("webhook not found", 404)

  const [body, parseErr] = await parseBody(req, BotWebhookUpdateSchema)
  if (parseErr) return parseErr

  const meta = BOT_WEBHOOK_PROVIDER_META[existing.provider]
  if (meta.secretMode !== "optional" && body.requireSecret === false) {
    return writeError(`${meta.label} webhooks require a signing secret`, 400)
  }
  if (meta.secretMode === "generated" && body.signingSecret !== undefined) {
    return writeError(`${meta.label} webhooks use a generated signing secret`, 400)
  }

  let newToken: string | undefined
  let newTokenHash: string | undefined
  let returnedSigningSecret: string | null | undefined
  let nextSigningSecretEnc: string | null | undefined
  let hasSigningSecretEnc = false

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
    },
  )
  if (!updated) return writeError("webhook not found", 404)

  const lastDelivery = await queries.communityBotWebhook.getLatestDeliveryForWebhook(db, webhookId)
  const payload: {
    webhook: ReturnType<typeof toBotWebhookSummary>
    webhookUrl?: string
    signingSecret?: string | null
  } = {
    webhook: toBotWebhookSummary(updated, lastDelivery),
  }

  if (newToken !== undefined) {
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

  const deleted = await queries.communityBotWebhook.deleteBotWebhook(
    db,
    ctx.userId,
    botId,
    webhookId,
  )
  if (!deleted) return writeError("webhook not found", 404)
  return writeJSON({ deleted: true })
})
