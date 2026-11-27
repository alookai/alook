import type { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import {
  BOT_WEBHOOK_MAX_BODY_BYTES,
  buildBotWebhookEventPrompt,
  formatGenericWebhookEvent,
  formatGitHubWebhookEvent,
  queries,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withEnv } from "@/lib/middleware/env"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { checkRateLimit } from "@/lib/rate-limit"
import {
  decryptBotWebhookSecret,
  dispatchBotWebhookDelivery,
  hashBotWebhookToken,
  readBoundedRawBody,
  verifyGenericWebhookSecret,
  verifyGitHubWebhookSignature,
} from "@/lib/community/bot-webhook.server"

export const POST = withEnv(async (req: NextRequest, ctx) => {
  const token = typeof ctx.params?.token === "string" ? ctx.params.token.trim() : ""
  if (!token || !token.startsWith("bwh_") || token.length < 16 || token.length > 128) {
    return writeError("webhook not found", 404)
  }

  const tokenHash = await hashBotWebhookToken(token)
  const limit = await checkRateLimit(ctx.env, "webhook:ingest", tokenHash.slice(0, 32))
  if (!limit.allowed) {
    return writeError("rate limit exceeded", 429, {
      "Retry-After": String(limit.retryAfterSec),
    })
  }

  const bodyResult = await readBoundedRawBody(req, BOT_WEBHOOK_MAX_BODY_BYTES)
  if (!bodyResult.ok) {
    return writeError("payload too large", 413)
  }

  const db = getPrimaryDb(ctx.env.DB)
  const webhook = await queries.communityBotWebhook.getBotWebhookByTokenHash(db, tokenHash)
  if (!webhook) {
    return writeError("webhook not found", 404)
  }

  if (!webhook.enabled) {
    return writeJSON({ ok: true, ignored: "disabled" })
  }

  let signingSecret: string | null = null
  if (webhook.signingSecretEnc) {
    signingSecret = await decryptBotWebhookSecret(ctx.env, webhook.signingSecretEnc)
    if (!signingSecret) {
      return writeError("webhook secret unavailable", 503)
    }
  }

  if (webhook.provider === "github") {
    if (!signingSecret) {
      return writeError("webhook secret unavailable", 503)
    }
    const valid = await verifyGitHubWebhookSignature(
      bodyResult.bytes,
      req.headers.get("x-hub-signature-256"),
      signingSecret,
    )
    if (!valid) {
      return writeError("invalid webhook signature", 401)
    }

    const ghEvent = (req.headers.get("x-github-event") ?? "").trim().toLowerCase()
    if (!ghEvent) {
      return writeError("missing X-GitHub-Event header", 400)
    }
    const externalDeliveryId = req.headers.get("x-github-delivery")?.trim() || null

    let parsedPayload: unknown
    try {
      const contentType = req.headers.get("content-type")?.toLowerCase() ?? ""
      const jsonSource = contentType.includes("application/x-www-form-urlencoded")
        ? (new URLSearchParams(bodyResult.text).get("payload") ?? "{}")
        : bodyResult.text
      parsedPayload = jsonSource.length > 0 ? JSON.parse(jsonSource) : {}
    } catch {
      return writeError("invalid JSON payload", 400)
    }

    const formatted = formatGitHubWebhookEvent(ghEvent, parsedPayload)

    if (ghEvent === "ping") {
      await queries.communityBotWebhook.createBotWebhookDelivery(db, {
        webhookId: webhook.id,
        ownerUserId: webhook.ownerUserId,
        botUserId: webhook.botUserId,
        externalDeliveryId,
        eventType: "ping",
        summary: formatted.summary,
        promptText: formatted.payloadText,
        status: "ignored",
        lastError: null,
      })
      return writeJSON({ ok: true, event: "ping" })
    }

    if (
      webhook.eventFilter &&
      webhook.eventFilter.length > 0 &&
      !webhook.eventFilter.includes(ghEvent)
    ) {
      await queries.communityBotWebhook.createBotWebhookDelivery(db, {
        webhookId: webhook.id,
        ownerUserId: webhook.ownerUserId,
        botUserId: webhook.botUserId,
        externalDeliveryId,
        eventType: formatted.eventType,
        summary: formatted.summary,
        promptText: "",
        status: "ignored",
        lastError: "event_filtered",
      })
      return writeJSON({ ok: true, ignored: "event_filtered" })
    }

    const deliveryId = `whd_${nanoid(16)}`
    const promptText = buildBotWebhookEventPrompt({
      webhookName: webhook.name,
      provider: "github",
      eventType: formatted.eventType,
      deliveryId,
      externalDeliveryId,
      instruction: webhook.instruction,
      payloadText: formatted.payloadText,
    })

    const { inserted, delivery } = await queries.communityBotWebhook.createBotWebhookDelivery(db, {
      id: deliveryId,
      webhookId: webhook.id,
      ownerUserId: webhook.ownerUserId,
      botUserId: webhook.botUserId,
      externalDeliveryId,
      eventType: formatted.eventType,
      summary: formatted.summary,
      promptText,
      status: "pending",
    })

    if (!inserted && delivery.status !== "pending") {
      return writeJSON({ ok: true, duplicate: true, deliveryId: delivery.id })
    }

    const dispatched = await dispatchBotWebhookDelivery(db, ctx.env, delivery)
    if (dispatched.outcome === "dispatched") {
      return writeJSON({ ok: true, delivered: true, deliveryId: dispatched.delivery.id })
    }
    if (dispatched.outcome === "pending") {
      return writeJSON({ ok: true, queued: true, deliveryId: dispatched.delivery.id }, 202)
    }
    return writeJSON(
      { ok: false, error: dispatched.delivery.lastError ?? "bot_unavailable", deliveryId: dispatched.delivery.id },
      202,
    )
  }

  if (signingSecret && !verifyGenericWebhookSecret(req, signingSecret)) {
    return writeError("invalid webhook secret", 401)
  }

  const externalDeliveryId =
    req.headers.get("x-alook-delivery")?.trim() ||
    req.headers.get("idempotency-key")?.trim() ||
    null
  const eventHeader = req.headers.get("x-webhook-event")?.trim() || null
  const formatted = formatGenericWebhookEvent(
    bodyResult.text,
    req.headers.get("content-type"),
    eventHeader,
  )

  const deliveryId = `whd_${nanoid(16)}`
  const promptText = buildBotWebhookEventPrompt({
    webhookName: webhook.name,
    provider: "generic",
    eventType: formatted.eventType,
    deliveryId,
    externalDeliveryId,
    instruction: webhook.instruction,
    payloadText: formatted.payloadText,
  })

  const { inserted, delivery } = await queries.communityBotWebhook.createBotWebhookDelivery(db, {
    id: deliveryId,
    webhookId: webhook.id,
    ownerUserId: webhook.ownerUserId,
    botUserId: webhook.botUserId,
    externalDeliveryId,
    eventType: formatted.eventType,
    summary: formatted.summary,
    promptText,
    status: "pending",
  })

  if (!inserted && delivery.status !== "pending") {
    return writeJSON({ ok: true, duplicate: true, deliveryId: delivery.id })
  }

  const dispatched = await dispatchBotWebhookDelivery(db, ctx.env, delivery)
  if (dispatched.outcome === "dispatched") {
    return writeJSON({ ok: true, delivered: true, deliveryId: dispatched.delivery.id })
  }
  if (dispatched.outcome === "pending") {
    return writeJSON({ ok: true, queued: true, deliveryId: dispatched.delivery.id }, 202)
  }
  return writeJSON(
    { ok: false, error: dispatched.delivery.lastError ?? "bot_unavailable", deliveryId: dispatched.delivery.id },
    202,
  )
})
