import type { NextRequest } from "next/server"
import {
  BOT_WEBHOOK_SUMMARY_MAX_LENGTH,
  ExternalSendRequestSchema,
  parseImReplyRefPlatform,
  queries,
} from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"
import {
  decryptOutboundImCreds,
  sendFeishuMessage,
  sendSlackMessage,
  sendTelegramMessage,
  type CloudImReplyTarget,
} from "@/lib/community/bot-im.server"

function summarizeReply(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= BOT_WEBHOOK_SUMMARY_MAX_LENGTH) return collapsed
  return `${collapsed.slice(0, BOT_WEBHOOK_SUMMARY_MAX_LENGTH - 1)}…`
}

export const POST = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const botUserId = gate.bot.userId

  const [body, parseErr] = await parseBody(req, ExternalSendRequestSchema)
  if (parseErr) return parseErr

  const platform = parseImReplyRefPlatform(body.externalRef)
  if (!platform) {
    return writeError("Unknown external reply ref", 400)
  }
  if (platform === "wechat") {
    return writeError("WeChat replies must be routed through the local daemon proxy", 400)
  }

  const db = getPrimaryDb(ctx.env.DB)
  const refRow = await queries.communityBotWebhook.getBotImReplyRef(db, botUserId, body.externalRef)
  if (!refRow) {
    return writeError("External reply ref not found", 404)
  }
  if (refRow.expiresAtMs <= Date.now()) {
    return writeError("External reply ref expired", 410)
  }

  const trigger = await queries.communityBotWebhook.getBotWebhookById(
    db,
    refRow.ownerUserId,
    botUserId,
    refRow.triggerId,
  )
  if (!trigger) {
    return writeError("IM trigger no longer exists", 404)
  }
  if (!trigger.enabled) {
    return writeError("IM trigger is paused", 409)
  }

  const creds = await decryptOutboundImCreds(ctx.env, trigger.outboundCredsEnc)
  if (!creds || creds.platform !== refRow.platform) {
    return writeError("Missing outbound IM credentials", 409)
  }

  let target: CloudImReplyTarget
  try {
    target = JSON.parse(refRow.targetJson) as CloudImReplyTarget
  } catch {
    return writeError("Corrupted reply target", 500)
  }

  let sendResult: { ok: true; messageId: string | null } | { ok: false; error: string }
  if (creds.platform === "telegram" && target.platform === "telegram") {
    sendResult = await sendTelegramMessage(creds.botToken, target, body.text)
  } else if (creds.platform === "feishu" && target.platform === "feishu") {
    sendResult = await sendFeishuMessage(
      ctx.env,
      trigger.id,
      trigger.config.region ?? "cn",
      creds.appId,
      creds.appSecret,
      target,
      body.text,
    )
  } else if (creds.platform === "slack" && target.platform === "slack") {
    sendResult = await sendSlackMessage(creds.botToken, target, body.text)
  } else {
    return writeError("Reply target platform mismatch", 400)
  }

  const summary = summarizeReply(body.text)
  await queries.communityBotWebhook.createBotWebhookDelivery(db, {
    webhookId: trigger.id,
    ownerUserId: trigger.ownerUserId,
    botUserId,
    externalDeliveryId: null,
    direction: "outbound",
    eventType: "im.reply",
    summary,
    promptText: "",
    status: sendResult.ok ? "dispatched" : "failed",
    lastError: sendResult.ok ? null : sendResult.error.slice(0, 240),
  })

  if (!sendResult.ok) {
    return writeError(`Failed to send ${refRow.platform} reply: ${sendResult.error}`, 502)
  }

  return writeJSON({
    state: "sent",
    externalRef: body.externalRef,
    platform: refRow.platform,
    messageId: sendResult.messageId,
  })
})
