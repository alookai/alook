import type { NextRequest } from "next/server"
import { DaemonImDeliveryReportSchema, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth-policy"
import { machineAuthPolicy } from "@/lib/middleware/community-daemon-auth"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import { broadcastBotAuditEvent } from "@/lib/community/bot-webhook.server"

export const POST = withAuth(machineAuthPolicy, async (req: NextRequest, ctx) => {
  const [body, parseErr] = await parseBody(req, DaemonImDeliveryReportSchema)
  if (parseErr) return parseErr

  const db = getPrimaryDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, body.botId, ctx.userId)
  if (!bot || bot.machineId !== ctx.machineId) {
    return writeError("bot not bound to this machine", 404)
  }

  const trigger = await queries.communityBotWebhook.getBotWebhookById(
    db,
    ctx.userId,
    body.botId,
    body.triggerId,
  )
  if (!trigger || trigger.transport !== "daemon_poll") {
    return writeError("daemon IM trigger not found", 404)
  }

  const { inserted, delivery } = await queries.communityBotWebhook.createBotWebhookDelivery(db, {
    webhookId: trigger.id,
    ownerUserId: ctx.userId,
    botUserId: body.botId,
    externalDeliveryId: body.externalDeliveryId ?? null,
    direction: body.direction,
    senderId: body.senderId ?? null,
    senderLabel: body.senderLabel ?? null,
    chatLabel: body.chatLabel ?? null,
    eventType: body.eventType,
    summary: body.summary,
    promptText: "",
    status: body.status,
    lastError: body.lastError ?? null,
    nowMs: body.occurredAtMs,
  })

  if (
    inserted &&
    body.recordAuditWake === true &&
    body.direction === "inbound" &&
    body.status === "dispatched" &&
    (trigger.provider === "telegram" ||
      trigger.provider === "feishu" ||
      trigger.provider === "slack" ||
      trigger.provider === "wechat")
  ) {
    const payload = {
      reason: "im" as const,
      triggerId: trigger.id,
      triggerName: trigger.name.slice(0, 120),
      platform: trigger.provider,
      senderLabel: (body.senderLabel?.trim() || body.senderId?.trim() || "Unknown sender").slice(0, 120),
      ...(body.chatLabel?.trim() ? { chatLabel: body.chatLabel.trim().slice(0, 120) } : {}),
      summary: body.summary.slice(0, 240),
    }
    try {
      const insertedAudit = await queries.communityBotAuditLog.insertBotAuditWakeTrigger(db, {
        botId: body.botId,
        launchId: delivery.id,
        payload,
      })
      if (insertedAudit) {
        await broadcastBotAuditEvent(ctx.env, {
          botId: body.botId,
          ownerUserId: ctx.userId,
          id: insertedAudit.id,
          kind: "wake_trigger",
          payload,
          createdAt: insertedAudit.createdAt,
          launchId: delivery.id,
        }).catch(() => undefined)
      }
    } catch {
      // Best-effort Activity Log recording.
    }
  }

  return writeJSON({ ok: true, deliveryId: delivery.id, inserted })
})
