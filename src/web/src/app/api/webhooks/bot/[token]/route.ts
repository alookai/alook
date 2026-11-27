import type { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import {
  BOT_WEBHOOK_MAX_BODY_BYTES,
  BOT_WEBHOOK_PROVIDER_META,
  buildBotWebhookEventPrompt,
  formatGenericWebhookEvent,
  formatGitHubWebhookEvent,
  formatGitLabWebhookEvent,
  formatLinearWebhookEvent,
  formatSentryWebhookEvent,
  formatSlackWebhookEvent,
  formatStandardWebhookEvent,
  formatStripeWebhookEvent,
  formatVercelWebhookEvent,
  queries,
  type FormattedWebhookEvent,
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
  verifyGitLabWebhookToken,
  verifyLinearWebhookSignature,
  verifySentryWebhookSignature,
  verifySlackWebhookSignature,
  verifyStandardWebhookSignature,
  verifyStripeWebhookSignature,
  verifyVercelWebhookSignature,
} from "@/lib/community/bot-webhook.server"

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: text.length > 0 ? JSON.parse(text) : {} }
  } catch {
    return { ok: false }
  }
}

function getStringField(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null
}

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

  const meta = BOT_WEBHOOK_PROVIDER_META[webhook.provider]

  let signingSecret: string | null = null
  if (webhook.signingSecretEnc) {
    signingSecret = await decryptBotWebhookSecret(ctx.env, webhook.signingSecretEnc)
    if (!signingSecret) {
      return writeError("webhook secret unavailable", 503)
    }
  } else if (meta.secretMode !== "optional") {
    return writeError(`${meta.label} signing secret is not configured yet`, 503)
  }

  let formatted: FormattedWebhookEvent
  let externalDeliveryId: string | null = null
  let filterEventKey: string | null = null

  switch (meta.protocol) {
    case "github": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifyGitHubWebhookSignature(
        bodyResult.bytes,
        req.headers.get("x-hub-signature-256"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const ghEvent = (req.headers.get("x-github-event") ?? "").trim().toLowerCase()
      if (!ghEvent) return writeError("missing X-GitHub-Event header", 400)
      externalDeliveryId = req.headers.get("x-github-delivery")?.trim() || null
      filterEventKey = ghEvent

      const contentType = req.headers.get("content-type")?.toLowerCase() ?? ""
      const jsonSource = contentType.includes("application/x-www-form-urlencoded")
        ? (new URLSearchParams(bodyResult.text).get("payload") ?? "{}")
        : bodyResult.text
      const parsed = parseJsonBody(jsonSource)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)

      formatted = formatGitHubWebhookEvent(ghEvent, parsed.value)
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
      break
    }

    case "linear": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifyLinearWebhookSignature(
        bodyResult.bytes,
        req.headers.get("linear-signature"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId = req.headers.get("linear-delivery")?.trim() || null
      formatted = formatLinearWebhookEvent(req.headers.get("linear-event"), parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "sentry": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifySentryWebhookSignature(
        bodyResult.bytes,
        req.headers.get("sentry-hook-signature"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId = req.headers.get("request-id")?.trim() || null
      formatted = formatSentryWebhookEvent(req.headers.get("sentry-hook-resource"), parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "stripe": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifyStripeWebhookSignature(
        bodyResult.text,
        req.headers.get("stripe-signature"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId = getStringField(parsed.value, "id")
      formatted = formatStripeWebhookEvent(parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "vercel": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifyVercelWebhookSignature(
        bodyResult.bytes,
        req.headers.get("x-vercel-signature"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId = getStringField(parsed.value, "id")
      formatted = formatVercelWebhookEvent(parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "gitlab": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = verifyGitLabWebhookToken(req.headers.get("x-gitlab-token"), signingSecret)
      if (!valid) return writeError("invalid webhook token", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId =
        req.headers.get("x-gitlab-event-uuid")?.trim() ||
        req.headers.get("x-gitlab-delivery")?.trim() ||
        null
      formatted = formatGitLabWebhookEvent(req.headers.get("x-gitlab-event"), parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "slack": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const valid = await verifySlackWebhookSignature(
        bodyResult.text,
        req.headers.get("x-slack-request-timestamp"),
        req.headers.get("x-slack-signature"),
        signingSecret,
      )
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)

      if (getStringField(parsed.value, "type") === "url_verification") {
        const challenge = getStringField(parsed.value, "challenge")
        if (!challenge) return writeError("missing Slack challenge", 400)
        await queries.communityBotWebhook.createBotWebhookDelivery(db, {
          webhookId: webhook.id,
          ownerUserId: webhook.ownerUserId,
          botUserId: webhook.botUserId,
          externalDeliveryId: null,
          eventType: "url_verification",
          summary: "Slack URL verification challenge",
          promptText: "",
          status: "ignored",
          lastError: null,
        })
        return writeJSON({ challenge })
      }

      externalDeliveryId = getStringField(parsed.value, "event_id")
      formatted = formatSlackWebhookEvent(parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "standard_webhooks": {
      if (!signingSecret) return writeError("webhook secret unavailable", 503)
      const msgId = req.headers.get("webhook-id") ?? req.headers.get("svix-id")
      const ts = req.headers.get("webhook-timestamp") ?? req.headers.get("svix-timestamp")
      const sig = req.headers.get("webhook-signature") ?? req.headers.get("svix-signature")
      const valid = await verifyStandardWebhookSignature(bodyResult.text, msgId, ts, sig, signingSecret)
      if (!valid) return writeError("invalid webhook signature", 401)

      const parsed = parseJsonBody(bodyResult.text)
      if (!parsed.ok) return writeError("invalid JSON payload", 400)
      externalDeliveryId = msgId?.trim() || null
      formatted = formatStandardWebhookEvent(meta.label, parsed.value)
      filterEventKey = formatted.eventType
      break
    }

    case "generic": {
      if (signingSecret && !verifyGenericWebhookSecret(req, signingSecret)) {
        return writeError("invalid webhook secret", 401)
      }
      externalDeliveryId =
        req.headers.get("x-alook-delivery")?.trim() ||
        req.headers.get("idempotency-key")?.trim() ||
        null
      formatted = formatGenericWebhookEvent(
        bodyResult.text,
        req.headers.get("content-type"),
        req.headers.get("x-webhook-event")?.trim() || null,
        webhook.provider === "generic" ? undefined : meta.label,
      )
      filterEventKey = formatted.eventType
      break
    }
  }

  if (
    filterEventKey &&
    webhook.eventFilter &&
    webhook.eventFilter.length > 0 &&
    !webhook.eventFilter.includes(filterEventKey)
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
    provider: webhook.provider,
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
