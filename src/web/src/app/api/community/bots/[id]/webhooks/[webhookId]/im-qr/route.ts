import type { NextRequest } from "next/server"
import { nanoid } from "nanoid"
import { computeBotTriggerConnectionStatus, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { withAuth } from "@/lib/middleware/auth-policy"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import {
  fetchImQrStatusFromMachine,
  startImQrLoginOnMachine,
} from "@/lib/community/bot-im.server"

export const POST = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const trigger = await queries.communityBotWebhook.getBotWebhookById(db, ctx.userId, botId, webhookId)
  if (!trigger) return writeError("trigger not found", 404)
  if (trigger.transport !== "daemon_poll" || trigger.provider !== "wechat") {
    return writeError("QR login is only supported for WeChat IM triggers", 400)
  }
  if (!bot.machineId) {
    return writeJSON({ error: "Bot is not bound to a machine", code: "machine_offline" }, 409)
  }
  const machine = await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, bot.machineId)
  if (!machine || machine.status !== "online") {
    return writeJSON({ error: "Bound machine is offline", code: "machine_offline" }, 409)
  }

  const started = await startImQrLoginOnMachine(ctx.env, bot.machineId, {
    type: "im:qr_start",
    requestId: `imqr_${nanoid(12)}`,
    botId,
    triggerId: trigger.id,
    provider: "wechat",
  })

  if (!started.ok) {
    if (started.code === "machine_offline") {
      return writeJSON({ error: "Bound machine is offline", code: "machine_offline" }, 409)
    }
    if (started.code === "unsupported") {
      return writeJSON(
        { error: "Update your Alook daemon to link WeChat", code: "daemon_upgrade_required" },
        409,
      )
    }
    if (started.code === "timeout") {
      return writeError("Timed out waiting for QR code from daemon", 504)
    }
    return writeError("Unable to reach daemon for QR login", 503)
  }

  if (started.frame.status === "error" || !started.frame.qrUrl || !started.frame.sessionId) {
    return writeError(started.frame.error || "Failed to generate WeChat QR code", 502)
  }

  const response = writeJSON({
    sessionId: started.frame.sessionId,
    qrUrl: started.frame.qrUrl,
    expiresAt: started.frame.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    status: started.frame.status === "confirmed" || started.frame.status === "connected" ? "confirmed" : "pending",
  })
  response.headers.set("Cache-Control", "no-store")
  return response
})

export const GET = withAuth(humanAuthPolicy, async (_req: NextRequest, ctx) => {
  const botId = ctx.params?.id as string
  const webhookId = ctx.params?.webhookId as string
  const db = getPrimaryDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const trigger = await queries.communityBotWebhook.getBotWebhookById(db, ctx.userId, botId, webhookId)
  if (!trigger) return writeError("trigger not found", 404)
  if (trigger.transport !== "daemon_poll") {
    return writeError("QR status is only supported for daemon IM triggers", 400)
  }

  const machine = bot.machineId
    ? await queries.communityMachine.getMachineByIdForUser(db, ctx.userId, bot.machineId)
    : null
  const machineOnline = machine ? machine.status === "online" : false
  const cached = bot.machineId
    ? await fetchImQrStatusFromMachine(ctx.env, bot.machineId, trigger.id)
    : null

  const connectionStatus = computeBotTriggerConnectionStatus({
    provider: trigger.provider,
    category: trigger.category,
    transport: trigger.transport,
    enabled: trigger.enabled,
    hasSigningSecret: trigger.signingSecretEnc !== null,
    hasOutboundCredentials: trigger.outboundCredsEnc !== null,
    config: trigger.config,
    machineOnline,
  })

  const qrStatus =
    cached?.qrStatus ??
    (trigger.config.daemonStatus === "connected"
      ? "confirmed"
      : trigger.config.daemonStatus === "error"
        ? "error"
        : "idle")

  const response = writeJSON({
    triggerId: trigger.id,
    connectionStatus,
    qrStatus,
    sessionId: cached?.sessionId ?? null,
    qrUrl: cached?.qrUrl ?? null,
    expiresAt: cached?.expiresAt ?? null,
    botAccountLabel: cached?.botAccountLabel ?? trigger.config.botAccountLabel ?? null,
    error: cached?.error ?? trigger.config.daemonLastError ?? null,
  })
  response.headers.set("Cache-Control", "no-store")
  return response
})
