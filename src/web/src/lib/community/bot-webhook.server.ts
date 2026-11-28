import {
  dispatchBotPrivateInboxEvent,
  resyncBotPrivateInboxForBots,
  type BotWebhookDelivery,
  type BotWebhookLastDelivery,
  type BotWebhookSummary,
  type Database,
  type StoredBotPrivateInboxEvent,
  type StoredBotPrivateInboxSummary,
  type StoredBotWebhook,
} from "@alook/shared"
import { pushBotEventToMachine } from "./bot-push"
import { syncOwnerScheduleAlarm } from "./schedule.server"

const SECRET_VERSION = "v1"
const REPLAY_TOLERANCE_SEC = 300

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function base64ToBytes(encoded: string): Uint8Array | null {
  const cleaned = encoded.trim()
  if (!cleaned) return null
  try {
    const bin = atob(cleaned)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}

async function computeHmacBytes(
  keyBytes: Uint8Array,
  dataBytes: Uint8Array,
  hash: "SHA-256" | "SHA-1",
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes as BufferSource))
}

async function verifyHmacHex(
  dataBytes: Uint8Array,
  receivedHex: string,
  secret: string,
  hash: "SHA-256" | "SHA-1",
): Promise<boolean> {
  const expectedLen = hash === "SHA-256" ? 32 : 20
  const received = hexToBytes(receivedHex.trim())
  if (!received || received.length !== expectedLen) return false
  const expected = await computeHmacBytes(new TextEncoder().encode(secret), dataBytes, hash)
  return constantTimeEqual(received, expected)
}

function isTimestampWithinTolerance(tsSec: number, nowMs: number): boolean {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return false
  const nowSec = Math.floor(nowMs / 1000)
  return Math.abs(nowSec - tsSec) <= REPLAY_TOLERANCE_SEC
}

export function newBotWebhookToken(): string {
  return `bwh_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`
}

export function newBotWebhookSigningSecret(): string {
  return `whsec_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`
}

export async function hashBotWebhookToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return bytesToHex(new Uint8Array(digest))
}

async function deriveSecretKey(env: Env): Promise<CryptoKey> {
  const master = env.ENCRYPTION_KEY || env.BETTER_AUTH_SECRET
  if (!master) {
    throw new Error("Webhook secret encryption key unavailable")
  }
  const keyMaterial = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`alook:bot-webhook-secret:v1:${master}`),
  )
  return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ])
}

export async function encryptBotWebhookSecret(env: Env, plaintext: string): Promise<string> {
  const key = await deriveSecretKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${SECRET_VERSION}:${bytesToHex(iv)}:${bytesToHex(new Uint8Array(encrypted))}`
}

export async function decryptBotWebhookSecret(env: Env, encoded: string): Promise<string | null> {
  const parts = encoded.split(":")
  if (parts.length !== 3 || parts[0] !== SECRET_VERSION) return null
  const iv = hexToBytes(parts[1]!)
  const ciphertext = hexToBytes(parts[2]!)
  if (!iv || iv.length !== 12 || !ciphertext) return null
  try {
    const key = await deriveSecretKey(env)
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    return null
  }
}

export async function verifyGitHubWebhookSignature(
  rawBytes: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false
  return verifyHmacHex(rawBytes, signatureHeader.slice("sha256=".length), secret, "SHA-256")
}

export async function verifyLinearWebhookSignature(
  rawBytes: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false
  return verifyHmacHex(rawBytes, signatureHeader, secret, "SHA-256")
}

export async function verifySentryWebhookSignature(
  rawBytes: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false
  return verifyHmacHex(rawBytes, signatureHeader, secret, "SHA-256")
}

export async function verifyStripeWebhookSignature(
  rawText: string,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!signatureHeader) return false
  let timestamp: string | null = null
  const signatures: string[] = []
  for (const part of signatureHeader.split(",")) {
    const eqIdx = part.indexOf("=")
    if (eqIdx <= 0) continue
    const k = part.slice(0, eqIdx).trim()
    const v = part.slice(eqIdx + 1).trim()
    if (k === "t") timestamp = v
    else if (k === "v1" && v) signatures.push(v)
  }
  if (!timestamp || signatures.length === 0) return false
  const tsSec = Number.parseInt(timestamp, 10)
  if (!isTimestampWithinTolerance(tsSec, nowMs)) return false
  const signedBytes = new TextEncoder().encode(`${timestamp}.${rawText}`)
  const expected = await computeHmacBytes(new TextEncoder().encode(secret), signedBytes, "SHA-256")
  for (const sigHex of signatures) {
    const received = hexToBytes(sigHex)
    if (received && received.length === 32 && constantTimeEqual(received, expected)) {
      return true
    }
  }
  return false
}

export async function verifyVercelWebhookSignature(
  rawBytes: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false
  return verifyHmacHex(rawBytes, signatureHeader, secret, "SHA-1")
}

export function verifyGitLabWebhookToken(tokenHeader: string | null, secret: string): boolean {
  const provided = tokenHeader?.trim() ?? null
  if (!provided) return false
  const enc = new TextEncoder()
  return constantTimeEqual(enc.encode(provided), enc.encode(secret))
}

export async function verifySlackWebhookSignature(
  rawText: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const ts = timestampHeader?.trim() ?? ""
  if (!ts || !signatureHeader || !signatureHeader.startsWith("v0=")) return false
  const tsSec = Number.parseInt(ts, 10)
  if (!isTimestampWithinTolerance(tsSec, nowMs)) return false
  const signedBytes = new TextEncoder().encode(`v0:${ts}:${rawText}`)
  return verifyHmacHex(signedBytes, signatureHeader.slice("v0=".length), secret, "SHA-256")
}

export async function verifyStandardWebhookSignature(
  rawText: string,
  msgIdHeader: string | null,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const msgId = msgIdHeader?.trim() ?? ""
  const ts = timestampHeader?.trim() ?? ""
  const sigs = signatureHeader?.trim() ?? ""
  if (!msgId || !ts || !sigs) return false
  const tsSec = Number.parseInt(ts, 10)
  if (!isTimestampWithinTolerance(tsSec, nowMs)) return false

  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret
  const keyBytes = base64ToBytes(rawSecret)
  if (!keyBytes || keyBytes.length === 0) return false

  const signedBytes = new TextEncoder().encode(`${msgId}.${ts}.${rawText}`)
  const expected = await computeHmacBytes(keyBytes, signedBytes, "SHA-256")

  for (const entry of sigs.split(/\s+/)) {
    if (!entry.startsWith("v1,")) continue
    const received = base64ToBytes(entry.slice("v1,".length))
    if (received && received.length === 32 && constantTimeEqual(received, expected)) {
      return true
    }
  }
  return false
}

export function verifyGenericWebhookSecret(req: Request, secret: string): boolean {
  const headerSecret = req.headers.get("x-webhook-secret")?.trim() ?? null
  const cfSecret = req.headers.get("cf-webhook-auth")?.trim() ?? null
  const auth = req.headers.get("authorization")?.trim() ?? null
  const bearerSecret = auth && /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim()
  const provided = headerSecret || cfSecret || bearerSecret || null
  if (!provided) return false
  const enc = new TextEncoder()
  return constantTimeEqual(enc.encode(provided), enc.encode(secret))
}

export async function readBoundedRawBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; code: "too_large" }> {
  const declaredLength = req.headers.get("content-length")
  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10)
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return { ok: false, code: "too_large" }
    }
  }
  if (!req.body) {
    return { ok: true, bytes: new Uint8Array(0), text: "" }
  }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { ok: false, code: "too_large" }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes, text: new TextDecoder().decode(bytes) }
}

export function buildBotWebhookUrl(req: Request, token: string): string {
  const origin = new URL(req.url).origin
  return `${origin}/api/webhooks/bot/${token}`
}

function toBotWebhookLastDelivery(
  row: StoredBotPrivateInboxSummary | StoredBotPrivateInboxEvent | null | undefined,
): BotWebhookLastDelivery | null {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    eventType: row.eventType,
    summary: row.summary,
    lastError: row.lastError,
    createdAt: new Date(row.createdAtMs).toISOString(),
  }
}

export function toBotWebhookDelivery(row: StoredBotPrivateInboxEvent): BotWebhookDelivery {
  return {
    id: row.id,
    webhookId: row.sourceId,
    eventType: row.eventType,
    summary: row.summary,
    status: row.status,
    lastError: row.lastError,
    externalDeliveryId: row.dedupeKey,
    createdAt: new Date(row.createdAtMs).toISOString(),
    dispatchedAt: row.dispatchedAtMs !== null ? new Date(row.dispatchedAtMs).toISOString() : null,
  }
}

export function toBotWebhookSummary(
  row: StoredBotWebhook,
  lastDelivery?: StoredBotPrivateInboxSummary | StoredBotPrivateInboxEvent | null,
): BotWebhookSummary {
  return {
    id: row.id,
    botId: row.botUserId,
    name: row.name,
    provider: row.provider,
    hasSigningSecret: row.signingSecretEnc !== null,
    eventFilter: row.eventFilter,
    instruction: row.instruction,
    enabled: row.enabled,
    lastTriggeredAt: row.lastTriggeredAtMs !== null ? new Date(row.lastTriggeredAtMs).toISOString() : null,
    createdAt: new Date(row.createdAtMs).toISOString(),
    updatedAt: new Date(row.updatedAtMs).toISOString(),
    lastDelivery: toBotWebhookLastDelivery(lastDelivery),
  }
}

export async function dispatchBotWebhookDelivery(
  db: Database,
  env: Env,
  delivery: StoredBotPrivateInboxEvent,
): Promise<{
  outcome: "dispatched" | "pending" | "failed"
  delivery: StoredBotPrivateInboxEvent
}> {
  const result = await dispatchBotPrivateInboxEvent(
    db,
    (machineId, command) => pushBotEventToMachine(env, machineId, command),
    delivery,
  )
  const outcome =
    result.outcome === "dispatched"
      ? "dispatched"
      : result.outcome === "pending"
        ? "pending"
        : "failed"
  return { outcome, delivery: result.event }
}

export async function resyncSystemPrivateInboxForBots(
  db: Database,
  env: Env,
  ownerUserId: string,
  botIds: readonly string[],
): Promise<{ attempted: number; dispatched: number; blocked: number }> {
  return resyncBotPrivateInboxForBots(
    db,
    (machineId, command) => pushBotEventToMachine(env, machineId, command),
    ownerUserId,
    botIds,
    {
      notifyScheduleChange: (ownerId, eventId, reason) =>
        syncOwnerScheduleAlarm(env, ownerId, { eventId, reason }),
    },
  )
}
