import { nanoid } from "nanoid"
import {
  IM_REPLY_REF_PREFIX,
  createLogger,
  type BotImConfig,
  type BotImFeishuRegion,
  type BotImProvider,
  type ImConfigSyncCommand,
  type ImQrStartCommand,
  type ImStatusFrame,
} from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"
import { decryptBotWebhookSecret, encryptBotWebhookSecret } from "./bot-webhook.server"

const log = createLogger({ service: "community-bot-im" })

export type OutboundImCreds =
  | { platform: "telegram"; botToken: string }
  | {
      platform: "feishu"
      appId: string
      appSecret: string
      verificationToken?: string | null
      encryptKey?: string | null
    }
  | { platform: "slack"; botToken: string }

export type CloudImReplyTarget =
  | { platform: "telegram"; chatId: string; replyToMessageId?: number }
  | { platform: "feishu"; chatId: string; messageId?: string }
  | { platform: "slack"; channel: string; threadTs?: string }

export interface ParsedInboundImMessage {
  platform: "telegram" | "feishu" | "slack"
  externalDeliveryId: string | null
  chatType: "dm" | "group"
  chatId: string
  chatName: string | null
  senderId: string
  senderLabel: string
  senderUsername: string | null
  text: string
  mentioned: boolean
  timeIso: string
  replyTarget: CloudImReplyTarget
}

export function newImReplyRef(platform: BotImProvider): string {
  return `${IM_REPLY_REF_PREFIX[platform]}${nanoid(12)}`
}

export async function encryptOutboundImCreds(env: Env, creds: OutboundImCreds): Promise<string> {
  return encryptBotWebhookSecret(env, JSON.stringify(creds))
}

export async function decryptOutboundImCreds(
  env: Env,
  encoded: string | null | undefined,
): Promise<OutboundImCreds | null> {
  if (!encoded) return null
  const raw = await decryptBotWebhookSecret(env, encoded)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as OutboundImCreds
    if (!parsed || typeof parsed !== "object" || typeof parsed.platform !== "string") return null
    return parsed
  } catch {
    return null
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i]! ^ bb[i]!
  }
  return diff === 0
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function base64ToBytes(encoded: string): Uint8Array | null {
  try {
    const bin = atob(encoded.trim())
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function isImSenderAllowed(
  config: BotImConfig,
  senderId: string,
  senderUsername?: string | null,
): boolean {
  if (config.accessPolicy === "anyone") return true
  const candidates = new Set<string>([senderId.trim().toLowerCase()])
  if (senderUsername && senderUsername.trim().length > 0) {
    const clean = senderUsername.trim().replace(/^@/, "").toLowerCase()
    candidates.add(clean)
    candidates.add(`@${clean}`)
  }
  for (const allowed of config.allowedSenders) {
    const norm = allowed.trim().toLowerCase()
    if (!norm) continue
    if (candidates.has(norm) || candidates.has(norm.replace(/^@/, ""))) {
      return true
    }
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Telegram                                                           */
/* ------------------------------------------------------------------ */

export function newTelegramSecretToken(): string {
  // Telegram secret_token allows [A-Za-z0-9_-]{1,256}.
  return `tg_${nanoid(32).replace(/[^A-Za-z0-9_-]/g, "x")}`
}

export function verifyTelegramSecretToken(headerValue: string | null, expectedSecret: string): boolean {
  const provided = headerValue?.trim() ?? ""
  if (!provided) return false
  return constantTimeStringEqual(provided, expectedSecret)
}

export async function registerTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; botUsername: string | null } | { ok: false; error: string }> {
  try {
    const meRes = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/getMe`)
    const meJson = (await meRes.json().catch(() => null)) as {
      ok?: boolean
      description?: string
      result?: { username?: string }
    } | null
    if (!meRes.ok || !meJson?.ok) {
      return { ok: false, error: meJson?.description || `Telegram getMe failed (${meRes.status})` }
    }
    const botUsername = asString(meJson.result?.username)

    const setRes = await fetchImpl(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/setWebhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: secretToken,
          allowed_updates: ["message"],
        }),
      },
    )
    const setJson = (await setRes.json().catch(() => null)) as {
      ok?: boolean
      description?: string
    } | null
    if (!setRes.ok || !setJson?.ok) {
      return {
        ok: false,
        error: setJson?.description || `Telegram setWebhook failed (${setRes.status})`,
      }
    }
    return { ok: true, botUsername }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Telegram API unreachable" }
  }
}

export async function deleteTelegramWebhook(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: false }),
    })
  } catch {
    // Best-effort cleanup on trigger deletion.
  }
}

export function parseTelegramInboundUpdate(
  payload: unknown,
  botUsername?: string | null,
): { kind: "message"; message: ParsedInboundImMessage } | { kind: "ignore"; reason: string } {
  if (!isRecord(payload)) return { kind: "ignore", reason: "invalid_payload" }
  const updateId = asNumber(payload.update_id)
  const msg = isRecord(payload.message) ? payload.message : null
  if (!msg) return { kind: "ignore", reason: "unsupported_update" }

  const from = isRecord(msg.from) ? msg.from : null
  if (!from) return { kind: "ignore", reason: "missing_sender" }
  if (from.is_bot === true) return { kind: "ignore", reason: "bot_self_message" }

  const chat = isRecord(msg.chat) ? msg.chat : null
  if (!chat) return { kind: "ignore", reason: "missing_chat" }

  const text = asString(msg.text) ?? asString(msg.caption)
  if (!text) return { kind: "ignore", reason: "non_text_message" }

  const senderIdNum = asNumber(from.id)
  const senderId = senderIdNum !== null ? String(senderIdNum) : asString(from.id)
  if (!senderId) return { kind: "ignore", reason: "missing_sender_id" }

  const chatIdNum = asNumber(chat.id)
  const chatId = chatIdNum !== null ? String(chatIdNum) : asString(chat.id)
  if (!chatId) return { kind: "ignore", reason: "missing_chat_id" }

  const senderUsername = asString(from.username)
  const fullName = [asString(from.first_name), asString(from.last_name)].filter(Boolean).join(" ")
  const senderLabel = fullName || (senderUsername ? `@${senderUsername}` : senderId)
  const chatTypeRaw = asString(chat.type)
  const chatType: "dm" | "group" = chatTypeRaw === "private" ? "dm" : "group"
  const chatName = chatType === "group" ? asString(chat.title) : null
  const messageId = asNumber(msg.message_id) ?? undefined
  const dateSec = asNumber(msg.date)
  const timeIso = dateSec !== null ? new Date(dateSec * 1000).toISOString() : new Date().toISOString()

  let mentioned = chatType === "dm"
  if (chatType === "group") {
    const normBot = botUsername?.trim().replace(/^@/, "").toLowerCase()
    const entities = Array.isArray(msg.entities)
      ? msg.entities
      : Array.isArray(msg.caption_entities)
        ? msg.caption_entities
        : []
    if (normBot) {
      for (const entity of entities) {
        if (!isRecord(entity)) continue
        const etype = asString(entity.type)
        const offset = asNumber(entity.offset)
        const length = asNumber(entity.length)
        if (etype === "mention" && offset !== null && length !== null) {
          const slice = text.slice(offset, offset + length).replace(/^@/, "").toLowerCase()
          if (slice === normBot) {
            mentioned = true
            break
          }
        }
      }
      if (!mentioned && isRecord(msg.reply_to_message)) {
        const replyFrom = isRecord(msg.reply_to_message.from) ? msg.reply_to_message.from : null
        const replyUsername = asString(replyFrom?.username)?.replace(/^@/, "").toLowerCase()
        if (replyUsername && replyUsername === normBot) {
          mentioned = true
        }
      }
    }
  }

  return {
    kind: "message",
    message: {
      platform: "telegram",
      externalDeliveryId: updateId !== null ? `tg_${updateId}` : messageId !== undefined ? `tg_m_${chatId}_${messageId}` : null,
      chatType,
      chatId,
      chatName,
      senderId,
      senderLabel,
      senderUsername,
      text,
      mentioned,
      timeIso,
      replyTarget: {
        platform: "telegram",
        chatId,
        ...(messageId !== undefined ? { replyToMessageId: messageId } : {}),
      },
    },
  }
}

export async function sendTelegramMessage(
  botToken: string,
  target: Extract<CloudImReplyTarget, { platform: "telegram" }>,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target.chatId,
          text,
          ...(target.replyToMessageId !== undefined
            ? { reply_to_message_id: target.replyToMessageId }
            : {}),
        }),
      },
    )
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean
      description?: string
      result?: { message_id?: number }
    } | null
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description || `Telegram sendMessage failed (${res.status})` }
    }
    return {
      ok: true,
      messageId: json.result?.message_id !== undefined ? String(json.result.message_id) : null,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Telegram send failed" }
  }
}

/* ------------------------------------------------------------------ */
/* Feishu / Lark                                                      */
/* ------------------------------------------------------------------ */

function feishuApiBase(region: BotImFeishuRegion): string {
  return region === "global" ? "https://open.larksuite.com" : "https://open.feishu.cn"
}

export async function verifyFeishuSignature(
  timestamp: string | null,
  nonce: string | null,
  encryptKey: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (!timestamp || !nonce || !signature) return false
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${timestamp}${nonce}${encryptKey}${rawBody}`),
  )
  return constantTimeStringEqual(bytesToHex(new Uint8Array(digest)), signature.trim().toLowerCase())
}

export async function decryptFeishuPayload(
  encryptKey: string,
  encryptedBase64: string,
): Promise<string | null> {
  const raw = base64ToBytes(encryptedBase64)
  if (!raw || raw.length <= 16) return null
  try {
    const keyHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey))
    const key = await crypto.subtle.importKey("raw", keyHash, { name: "AES-CBC" }, false, ["decrypt"])
    const iv = raw.slice(0, 16)
    const ciphertext = raw.slice(16)
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    return null
  }
}

export function parseFeishuInboundEvent(
  payload: unknown,
  expectedVerificationToken?: string | null,
):
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; message: ParsedInboundImMessage }
  | { kind: "unauthorized"; reason: string }
  | { kind: "ignore"; reason: string } {
  if (!isRecord(payload)) return { kind: "ignore", reason: "invalid_payload" }

  const header = isRecord(payload.header) ? payload.header : null
  const token = asString(payload.token) ?? asString(header?.token)
  if (expectedVerificationToken && (!token || !constantTimeStringEqual(token, expectedVerificationToken))) {
    return { kind: "unauthorized", reason: "invalid_verification_token" }
  }

  if (asString(payload.type) === "url_verification") {
    const challenge = asString(payload.challenge)
    if (!challenge) return { kind: "ignore", reason: "missing_challenge" }
    return { kind: "url_verification", challenge }
  }

  const eventType = asString(header?.event_type)
  if (eventType !== "im.message.receive_v1") {
    return { kind: "ignore", reason: eventType ? `unsupported_${eventType}` : "unsupported_event" }
  }

  const event = isRecord(payload.event) ? payload.event : null
  if (!event) return { kind: "ignore", reason: "missing_event" }
  const sender = isRecord(event.sender) ? event.sender : null
  if (asString(sender?.sender_type) === "app") {
    return { kind: "ignore", reason: "bot_self_message" }
  }
  const senderIdObj = isRecord(sender?.sender_id) ? sender.sender_id : null
  const senderId =
    asString(senderIdObj?.open_id) ??
    asString(senderIdObj?.user_id) ??
    asString(senderIdObj?.union_id)
  if (!senderId) return { kind: "ignore", reason: "missing_sender_id" }

  const message = isRecord(event.message) ? event.message : null
  if (!message) return { kind: "ignore", reason: "missing_message" }
  const chatId = asString(message.chat_id)
  if (!chatId) return { kind: "ignore", reason: "missing_chat_id" }
  const messageId = asString(message.message_id)
  const chatTypeRaw = asString(message.chat_type)
  const chatType: "dm" | "group" = chatTypeRaw === "p2p" ? "dm" : "group"

  const rawContent = asString(message.content)
  let text: string | null = null
  if (rawContent) {
    try {
      const parsedContent = JSON.parse(rawContent) as unknown
      if (isRecord(parsedContent)) {
        text = asString(parsedContent.text)
      }
    } catch {
      text = rawContent
    }
  }
  if (!text) return { kind: "ignore", reason: "non_text_message" }

  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  const mentioned = chatType === "dm" || mentions.length > 0
  const createTimeMs = Number.parseInt(asString(message.create_time) ?? "", 10)
  const timeIso = Number.isFinite(createTimeMs) && createTimeMs > 0
    ? new Date(createTimeMs).toISOString()
    : new Date().toISOString()

  return {
    kind: "message",
    message: {
      platform: "feishu",
      externalDeliveryId: asString(header?.event_id) ?? (messageId ? `fs_${messageId}` : null),
      chatType,
      chatId,
      chatName: chatType === "group" ? chatId : null,
      senderId,
      senderLabel: senderId,
      senderUsername: null,
      text,
      mentioned,
      timeIso,
      replyTarget: {
        platform: "feishu",
        chatId,
        ...(messageId ? { messageId } : {}),
      },
    },
  }
}

async function getFeishuTenantAccessToken(
  env: Env,
  triggerId: string,
  region: BotImFeishuRegion,
  appId: string,
  appSecret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const kvKey = `im:feishu:tat:${triggerId}:${region}`
  try {
    const cached = await env.CACHE_KV?.get(kvKey)
    if (cached) return { ok: true, token: cached }
  } catch {
    // Ignore KV cache read error and fetch live token.
  }

  try {
    const base = feishuApiBase(region)
    const res = await fetchImpl(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    })
    const json = (await res.json().catch(() => null)) as {
      code?: number
      msg?: string
      tenant_access_token?: string
      expire?: number
    } | null
    if (!res.ok || !json || json.code !== 0 || !json.tenant_access_token) {
      return { ok: false, error: json?.msg || `Feishu auth failed (${res.status})` }
    }
    const ttl = Math.max(60, (json.expire ?? 7200) - 300)
    try {
      await env.CACHE_KV?.put(kvKey, json.tenant_access_token, { expirationTtl: ttl })
    } catch {
      // Best-effort KV cache write.
    }
    return { ok: true, token: json.tenant_access_token }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Feishu auth unreachable" }
  }
}

export async function sendFeishuMessage(
  env: Env,
  triggerId: string,
  region: BotImFeishuRegion,
  appId: string,
  appSecret: string,
  target: Extract<CloudImReplyTarget, { platform: "feishu" }>,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  const tokenResult = await getFeishuTenantAccessToken(
    env,
    triggerId,
    region,
    appId,
    appSecret,
    fetchImpl,
  )
  if (!tokenResult.ok) return tokenResult

  const base = feishuApiBase(region)
  const url = target.messageId
    ? `${base}/open-apis/im/v1/messages/${encodeURIComponent(target.messageId)}/reply`
    : `${base}/open-apis/im/v1/messages?receive_id_type=chat_id`
  const body = target.messageId
    ? { msg_type: "text", content: JSON.stringify({ text }) }
    : { receive_id: target.chatId, msg_type: "text", content: JSON.stringify({ text }) }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokenResult.token}`,
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => null)) as {
      code?: number
      msg?: string
      data?: { message_id?: string }
    } | null
    if (!res.ok || !json || json.code !== 0) {
      return { ok: false, error: json?.msg || `Feishu send failed (${res.status})` }
    }
    return { ok: true, messageId: asString(json.data?.message_id) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Feishu send unreachable" }
  }
}

/* ------------------------------------------------------------------ */
/* Slack                                                              */
/* ------------------------------------------------------------------ */

export function parseSlackInboundImEvent(
  payload: unknown,
):
  | { kind: "url_verification"; challenge: string }
  | { kind: "message"; message: ParsedInboundImMessage }
  | { kind: "ignore"; reason: string } {
  if (!isRecord(payload)) return { kind: "ignore", reason: "invalid_payload" }
  const outerType = asString(payload.type)
  if (outerType === "url_verification") {
    const challenge = asString(payload.challenge)
    if (!challenge) return { kind: "ignore", reason: "missing_challenge" }
    return { kind: "url_verification", challenge }
  }
  if (outerType !== "event_callback") {
    return { kind: "ignore", reason: outerType ? `unsupported_${outerType}` : "unsupported_type" }
  }

  const event = isRecord(payload.event) ? payload.event : null
  if (!event) return { kind: "ignore", reason: "missing_event" }
  const eventType = asString(event.type)
  if (eventType !== "app_mention" && eventType !== "message") {
    return { kind: "ignore", reason: `unsupported_${eventType ?? "event"}` }
  }

  // Drop bot-own or edited/deleted system subtypes to prevent reply loops.
  const subtype = asString(event.subtype)
  if (event.bot_id || subtype === "bot_message" || subtype === "message_changed" || subtype === "message_deleted") {
    return { kind: "ignore", reason: "bot_self_message" }
  }

  const senderId = asString(event.user)
  const channel = asString(event.channel)
  const text = asString(event.text)
  if (!senderId || !channel || !text) {
    return { kind: "ignore", reason: "missing_fields" }
  }

  const channelType = asString(event.channel_type)
  const chatType: "dm" | "group" = channelType === "im" || channel.startsWith("D") ? "dm" : "group"
  const mentioned = chatType === "dm" || eventType === "app_mention"
  const threadTs = asString(event.thread_ts) ?? asString(event.ts) ?? undefined
  const tsSec = Number.parseFloat(asString(event.ts) ?? "")
  const timeIso = Number.isFinite(tsSec) && tsSec > 0
    ? new Date(Math.floor(tsSec * 1000)).toISOString()
    : new Date().toISOString()

  return {
    kind: "message",
    message: {
      platform: "slack",
      externalDeliveryId: asString(payload.event_id) ?? (threadTs ? `sl_${channel}_${threadTs}` : null),
      chatType,
      chatId: channel,
      chatName: chatType === "group" ? channel : null,
      senderId,
      senderLabel: senderId,
      senderUsername: null,
      text,
      mentioned,
      timeIso,
      replyTarget: {
        platform: "slack",
        channel,
        ...(threadTs ? { threadTs } : {}),
      },
    },
  }
}

export async function sendSlackMessage(
  botToken: string,
  target: Extract<CloudImReplyTarget, { platform: "slack" }>,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; messageId: string | null } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: target.channel,
        text,
        ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      }),
    })
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean
      error?: string
      ts?: string
    } | null
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.error || `Slack chat.postMessage failed (${res.status})` }
    }
    return { ok: true, messageId: asString(json.ts) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Slack API unreachable" }
  }
}

/* ------------------------------------------------------------------ */
/* ws-do IM control-plane helpers                                     */
/* ------------------------------------------------------------------ */

export async function pushImConfigSyncToMachine(
  env: Env,
  machineId: string,
  command: ImConfigSyncCommand,
): Promise<{ sent: number; unsupported: number }> {
  try {
    const res = await wsDoFetch(
      env,
      `/community-machine/by-id/${encodeURIComponent(machineId)}/im`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
      { label: machineId, type: command.type },
    )
    if (!res.ok) return { sent: 0, unsupported: 0 }
    const data = (await res.json()) as { sent?: number; unsupported?: number }
    return { sent: data.sent ?? 0, unsupported: data.unsupported ?? 0 }
  } catch (err) {
    log.warn("im:config_sync push failed", { machineId, err: String(err) })
    return { sent: 0, unsupported: 0 }
  }
}

export async function startImQrLoginOnMachine(
  env: Env,
  machineId: string,
  command: ImQrStartCommand,
): Promise<
  | { ok: true; frame: ImStatusFrame }
  | { ok: false; code: "machine_offline" | "unsupported" | "timeout" | "unavailable" }
> {
  try {
    const res = await wsDoFetch(
      env,
      `/community-machine/by-id/${encodeURIComponent(machineId)}/im?wait=1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
      { label: machineId, type: command.type },
    )
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean
      code?: "machine_offline" | "unsupported" | "timeout"
      frame?: ImStatusFrame
    } | null
    if (res.ok && data?.ok && data.frame) {
      return { ok: true, frame: data.frame }
    }
    return { ok: false, code: data?.code ?? "unavailable" }
  } catch (err) {
    log.warn("im:qr_start push failed", { machineId, err: String(err) })
    return { ok: false, code: "unavailable" }
  }
}

export async function fetchImQrStatusFromMachine(
  env: Env,
  machineId: string,
  triggerId: string,
): Promise<{
  qrStatus: "idle" | "pending" | "scanned" | "confirmed" | "expired" | "error"
  sessionId: string | null
  qrUrl: string | null
  expiresAt: string | null
  botAccountLabel: string | null
  error: string | null
} | null> {
  try {
    const res = await wsDoFetch(
      env,
      `/community-machine/by-id/${encodeURIComponent(machineId)}/im-qr-status?triggerId=${encodeURIComponent(triggerId)}`,
      { method: "GET" },
      { label: machineId, type: "im:qr_status" },
    )
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as {
      state?: {
        qrStatus: "idle" | "pending" | "scanned" | "confirmed" | "expired" | "error"
        sessionId: string | null
        qrUrl: string | null
        expiresAt: string | null
        botAccountLabel: string | null
        error: string | null
      } | null
    } | null
    return data?.state ?? null
  } catch {
    return null
  }
}
