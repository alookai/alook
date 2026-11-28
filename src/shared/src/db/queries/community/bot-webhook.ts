import { and, desc, eq, inArray, lt } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Database } from "../../index"
import {
  communityBotImReplyRef,
  communityBotWebhook,
} from "../../community-bot-webhook-schema"
import {
  BOT_IM_MAX_ALLOWED_SENDERS,
  BOT_IM_REPLY_REF_TTL_MS,
  BOT_WEBHOOK_DELIVERY_LIST_DEFAULT,
  BOT_WEBHOOK_DELIVERY_RETENTION,
  BOT_WEBHOOK_MAX_PER_BOT,
  getProviderCategory,
  getProviderTransport,
  parseBotImConfig,
  type BotImConfig,
  type BotImDaemonStatus,
  type BotImProvider,
  type BotTriggerCategory,
  type BotTriggerTransport,
  type BotWebhookDeliveryDirection,
  type BotWebhookDeliveryStatus,
  type BotWebhookProvider,
} from "../../../bot-webhook"
import {
  deletePrivateInboxEventsForSource,
  enqueuePrivateInboxEvent,
  getLatestPrivateInboxEventForSource,
  getLatestPrivateInboxEventsBySources,
  listPrivateInboxEventsForSource,
  type StoredBotPrivateInboxEvent,
  type StoredBotPrivateInboxSummary,
} from "./bot-private-inbox"

export interface StoredBotWebhook {
  id: string
  ownerUserId: string
  botUserId: string
  name: string
  provider: BotWebhookProvider
  category: BotTriggerCategory
  transport: BotTriggerTransport
  tokenHash: string
  signingSecretEnc: string | null
  config: BotImConfig
  outboundCredsEnc: string | null
  eventFilter: string[] | null
  instruction: string
  enabled: boolean
  lastTriggeredAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
}

export interface StoredBotImReplyRef {
  botUserId: string
  ref: string
  ownerUserId: string
  triggerId: string
  platform: BotImProvider
  targetJson: string
  expiresAtMs: number
  createdAtMs: number
}

export type StoredBotWebhookDelivery = StoredBotPrivateInboxEvent
export type StoredBotWebhookLastDelivery = StoredBotPrivateInboxSummary

function parseEventFilter(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return null
  }
}

function mapWebhookRow(row: typeof communityBotWebhook.$inferSelect): StoredBotWebhook {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    botUserId: row.botUserId,
    name: row.name,
    provider: row.provider,
    category: row.category ?? getProviderCategory(row.provider),
    transport: row.transport ?? getProviderTransport(row.provider),
    tokenHash: row.tokenHash,
    signingSecretEnc: row.signingSecretEnc ?? null,
    config: parseBotImConfig(row.configJson),
    outboundCredsEnc: row.outboundCredsEnc ?? null,
    eventFilter: parseEventFilter(row.eventFilterJson),
    instruction: row.instruction,
    enabled: Boolean(row.enabled),
    lastTriggeredAtMs: row.lastTriggeredAtMs ?? null,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  }
}

export async function listBotWebhooks(
  db: Database,
  ownerUserId: string,
  botUserId: string,
): Promise<{
  webhooks: StoredBotWebhook[]
  lastDeliveryByWebhookId: Record<string, StoredBotWebhookLastDelivery>
}> {
  const rows = await db
    .select()
    .from(communityBotWebhook)
    .where(
      and(
        eq(communityBotWebhook.ownerUserId, ownerUserId),
        eq(communityBotWebhook.botUserId, botUserId),
      ),
    )
    .orderBy(desc(communityBotWebhook.createdAtMs))
    .limit(BOT_WEBHOOK_MAX_PER_BOT)

  const webhooks = rows.map(mapWebhookRow)
  const lastDeliveryByWebhookId = await getLatestPrivateInboxEventsBySources(
    db,
    "webhook",
    webhooks.map((w) => w.id),
  )

  return { webhooks, lastDeliveryByWebhookId }
}

export async function listDaemonPollImTriggersForBots(
  db: Database,
  ownerUserId: string,
  botUserIds: readonly string[],
): Promise<StoredBotWebhook[]> {
  const uniqueBotIds = [...new Set(botUserIds)]
  if (uniqueBotIds.length === 0) return []
  const rows = await db
    .select()
    .from(communityBotWebhook)
    .where(
      and(
        eq(communityBotWebhook.ownerUserId, ownerUserId),
        inArray(communityBotWebhook.botUserId, uniqueBotIds),
        eq(communityBotWebhook.transport, "daemon_poll"),
      ),
    )
    .orderBy(desc(communityBotWebhook.createdAtMs))
    .limit(BOT_WEBHOOK_MAX_PER_BOT * Math.min(uniqueBotIds.length, 50))
  return rows.map(mapWebhookRow)
}

export async function getBotWebhookById(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  webhookId: string,
): Promise<StoredBotWebhook | null> {
  const rows = await db
    .select()
    .from(communityBotWebhook)
    .where(
      and(
        eq(communityBotWebhook.id, webhookId),
        eq(communityBotWebhook.ownerUserId, ownerUserId),
        eq(communityBotWebhook.botUserId, botUserId),
      ),
    )
    .limit(1)
  return rows[0] ? mapWebhookRow(rows[0]) : null
}

export async function getLatestDeliveryForWebhook(
  db: Database,
  webhookId: string,
): Promise<StoredBotWebhookLastDelivery | null> {
  return getLatestPrivateInboxEventForSource(db, "webhook", webhookId)
}

export async function getBotWebhookByTokenHash(
  db: Database,
  tokenHash: string,
): Promise<StoredBotWebhook | null> {
  const rows = await db
    .select()
    .from(communityBotWebhook)
    .where(eq(communityBotWebhook.tokenHash, tokenHash))
    .limit(1)
  return rows[0] ? mapWebhookRow(rows[0]) : null
}

export async function createBotWebhook(
  db: Database,
  input: {
    ownerUserId: string
    botUserId: string
    name: string
    provider: BotWebhookProvider
    category?: BotTriggerCategory
    transport?: BotTriggerTransport
    tokenHash: string
    signingSecretEnc: string | null
    config?: BotImConfig | null
    outboundCredsEnc?: string | null
    eventFilter: string[] | null
    instruction: string
    nowMs?: number
  },
): Promise<{ ok: true; webhook: StoredBotWebhook } | { ok: false; code: "limit_exceeded" }> {
  const existing = await db
    .select({ id: communityBotWebhook.id })
    .from(communityBotWebhook)
    .where(
      and(
        eq(communityBotWebhook.ownerUserId, input.ownerUserId),
        eq(communityBotWebhook.botUserId, input.botUserId),
      ),
    )
    .limit(BOT_WEBHOOK_MAX_PER_BOT)
  if (existing.length >= BOT_WEBHOOK_MAX_PER_BOT) {
    return { ok: false, code: "limit_exceeded" }
  }

  const nowMs = input.nowMs ?? Date.now()
  const id = `bwh_${nanoid(16)}`
  const category = input.category ?? getProviderCategory(input.provider)
  const transport = input.transport ?? getProviderTransport(input.provider)
  const config = input.config ?? parseBotImConfig(null)
  const configJson = category === "im" ? JSON.stringify(config) : null
  const outboundCredsEnc = input.outboundCredsEnc ?? null
  const eventFilterJson = input.eventFilter ? JSON.stringify(input.eventFilter) : null

  await db.insert(communityBotWebhook).values({
    id,
    ownerUserId: input.ownerUserId,
    botUserId: input.botUserId,
    name: input.name,
    provider: input.provider,
    category,
    transport,
    tokenHash: input.tokenHash,
    signingSecretEnc: input.signingSecretEnc,
    configJson,
    outboundCredsEnc,
    eventFilterJson,
    instruction: input.instruction,
    enabled: true,
    lastTriggeredAtMs: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  })

  return {
    ok: true,
    webhook: {
      id,
      ownerUserId: input.ownerUserId,
      botUserId: input.botUserId,
      name: input.name,
      provider: input.provider,
      category,
      transport,
      tokenHash: input.tokenHash,
      signingSecretEnc: input.signingSecretEnc,
      config,
      outboundCredsEnc,
      eventFilter: input.eventFilter,
      instruction: input.instruction,
      enabled: true,
      lastTriggeredAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    },
  }
}

export async function updateBotWebhook(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  webhookId: string,
  patch: {
    name?: string
    enabled?: boolean
    eventFilter?: string[] | null
    hasEventFilter?: boolean
    instruction?: string
    tokenHash?: string
    signingSecretEnc?: string | null
    hasSigningSecretEnc?: boolean
    config?: BotImConfig
    hasConfig?: boolean
    outboundCredsEnc?: string | null
    hasOutboundCredsEnc?: boolean
    nowMs?: number
  },
): Promise<StoredBotWebhook | null> {
  const nowMs = patch.nowMs ?? Date.now()
  const values: Partial<typeof communityBotWebhook.$inferInsert> = {
    updatedAtMs: nowMs,
  }
  if (patch.name !== undefined) values.name = patch.name
  if (patch.enabled !== undefined) values.enabled = patch.enabled
  if (patch.hasEventFilter) {
    values.eventFilterJson = patch.eventFilter ? JSON.stringify(patch.eventFilter) : null
  }
  if (patch.instruction !== undefined) values.instruction = patch.instruction
  if (patch.tokenHash !== undefined) values.tokenHash = patch.tokenHash
  if (patch.hasSigningSecretEnc) {
    values.signingSecretEnc = patch.signingSecretEnc ?? null
  }
  if (patch.hasConfig && patch.config !== undefined) {
    values.configJson = JSON.stringify(patch.config)
  }
  if (patch.hasOutboundCredsEnc) {
    values.outboundCredsEnc = patch.outboundCredsEnc ?? null
  }

  const rows = await db
    .update(communityBotWebhook)
    .set(values)
    .where(
      and(
        eq(communityBotWebhook.id, webhookId),
        eq(communityBotWebhook.ownerUserId, ownerUserId),
        eq(communityBotWebhook.botUserId, botUserId),
      ),
    )
    .returning()

  return rows[0] ? mapWebhookRow(rows[0]) : null
}

export async function allowBotImTriggerSender(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  triggerId: string,
  senderId: string,
  nowMs = Date.now(),
): Promise<
  | { ok: true; webhook: StoredBotWebhook; added: boolean }
  | { ok: false; code: "not_found" | "limit_exceeded" }
> {
  const existing = await getBotWebhookById(db, ownerUserId, botUserId, triggerId)
  if (!existing) return { ok: false, code: "not_found" }

  const normalized = senderId.trim()
  if (existing.config.allowedSenders.includes(normalized)) {
    return { ok: true, webhook: existing, added: false }
  }
  if (existing.config.allowedSenders.length >= BOT_IM_MAX_ALLOWED_SENDERS) {
    return { ok: false, code: "limit_exceeded" }
  }

  const nextConfig: BotImConfig = {
    ...existing.config,
    allowedSenders: [...existing.config.allowedSenders, normalized],
  }
  const updated = await updateBotWebhook(db, ownerUserId, botUserId, triggerId, {
    config: nextConfig,
    hasConfig: true,
    nowMs,
  })
  if (!updated) return { ok: false, code: "not_found" }
  return { ok: true, webhook: updated, added: true }
}

export async function updateBotImDaemonStatus(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  triggerId: string,
  patch: {
    daemonStatus: BotImDaemonStatus
    botAccountLabel?: string | null
    daemonLastError?: string | null
    nowMs?: number
  },
): Promise<StoredBotWebhook | null> {
  const existing = await getBotWebhookById(db, ownerUserId, botUserId, triggerId)
  if (!existing) return null
  const nowMs = patch.nowMs ?? Date.now()
  const nextConfig: BotImConfig = {
    ...existing.config,
    daemonStatus: patch.daemonStatus,
    ...(patch.botAccountLabel !== undefined ? { botAccountLabel: patch.botAccountLabel } : {}),
    daemonLastError: patch.daemonLastError ?? null,
    daemonUpdatedAtMs: nowMs,
  }
  return updateBotWebhook(db, ownerUserId, botUserId, triggerId, {
    config: nextConfig,
    hasConfig: true,
    nowMs,
  })
}

export async function deleteBotWebhook(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  webhookId: string,
): Promise<boolean> {
  const rows = await db
    .delete(communityBotWebhook)
    .where(
      and(
        eq(communityBotWebhook.id, webhookId),
        eq(communityBotWebhook.ownerUserId, ownerUserId),
        eq(communityBotWebhook.botUserId, botUserId),
      ),
    )
    .returning({ id: communityBotWebhook.id })
  if (rows.length === 0) return false
  await deletePrivateInboxEventsForSource(db, "webhook", webhookId)
  await db
    .delete(communityBotImReplyRef)
    .where(eq(communityBotImReplyRef.triggerId, webhookId))
  return true
}

export async function createBotWebhookDelivery(
  db: Database,
  input: {
    id?: string
    webhookId: string
    ownerUserId: string
    botUserId: string
    externalDeliveryId: string | null
    direction?: BotWebhookDeliveryDirection
    senderId?: string | null
    senderLabel?: string | null
    chatLabel?: string | null
    eventType: string
    summary: string
    promptText: string
    status: BotWebhookDeliveryStatus
    lastError?: string | null
    nowMs?: number
  },
): Promise<{ inserted: boolean; delivery: StoredBotWebhookDelivery }> {
  const nowMs = input.nowMs ?? Date.now()
  const { inserted, event } = await enqueuePrivateInboxEvent(db, {
    id: input.id,
    ownerUserId: input.ownerUserId,
    botUserId: input.botUserId,
    sourceKind: "webhook",
    sourceId: input.webhookId,
    dedupeKey: input.externalDeliveryId,
    direction: input.direction ?? "inbound",
    senderId: input.senderId,
    senderLabel: input.senderLabel,
    chatLabel: input.chatLabel,
    eventType: input.eventType,
    summary: input.summary,
    promptText: input.promptText,
    status: input.status,
    lastError: input.lastError,
    nowMs,
    retentionLimit: BOT_WEBHOOK_DELIVERY_RETENTION,
  })

  if (inserted) {
    await db
      .update(communityBotWebhook)
      .set({ lastTriggeredAtMs: nowMs })
      .where(eq(communityBotWebhook.id, input.webhookId))
  }

  return { inserted, delivery: event }
}

export async function listBotWebhookDeliveries(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  webhookId: string,
  limit = BOT_WEBHOOK_DELIVERY_LIST_DEFAULT,
): Promise<StoredBotWebhookDelivery[]> {
  return listPrivateInboxEventsForSource(db, ownerUserId, botUserId, "webhook", webhookId, limit)
}

export async function upsertBotImReplyRef(
  db: Database,
  input: {
    botUserId: string
    ref: string
    ownerUserId: string
    triggerId: string
    platform: BotImProvider
    targetJson: string
    nowMs?: number
    ttlMs?: number
  },
): Promise<StoredBotImReplyRef> {
  const nowMs = input.nowMs ?? Date.now()
  const expiresAtMs = nowMs + (input.ttlMs ?? BOT_IM_REPLY_REF_TTL_MS)
  await db
    .insert(communityBotImReplyRef)
    .values({
      botUserId: input.botUserId,
      ref: input.ref,
      ownerUserId: input.ownerUserId,
      triggerId: input.triggerId,
      platform: input.platform,
      targetJson: input.targetJson,
      expiresAtMs,
      createdAtMs: nowMs,
    })
    .onConflictDoUpdate({
      target: [communityBotImReplyRef.botUserId, communityBotImReplyRef.ref],
      set: {
        targetJson: input.targetJson,
        expiresAtMs,
      },
    })

  // Best-effort bounded pruning of expired refs for this trigger using idx_community_bot_im_reply_ref_trigger_expires.
  await db
    .delete(communityBotImReplyRef)
    .where(
      and(
        eq(communityBotImReplyRef.triggerId, input.triggerId),
        lt(communityBotImReplyRef.expiresAtMs, nowMs),
      ),
    )

  return {
    botUserId: input.botUserId,
    ref: input.ref,
    ownerUserId: input.ownerUserId,
    triggerId: input.triggerId,
    platform: input.platform,
    targetJson: input.targetJson,
    expiresAtMs,
    createdAtMs: nowMs,
  }
}

export async function getBotImReplyRef(
  db: Database,
  botUserId: string,
  ref: string,
): Promise<StoredBotImReplyRef | null> {
  const rows = await db
    .select()
    .from(communityBotImReplyRef)
    .where(
      and(
        eq(communityBotImReplyRef.botUserId, botUserId),
        eq(communityBotImReplyRef.ref, ref),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    botUserId: row.botUserId,
    ref: row.ref,
    ownerUserId: row.ownerUserId,
    triggerId: row.triggerId,
    platform: row.platform,
    targetJson: row.targetJson,
    expiresAtMs: row.expiresAtMs,
    createdAtMs: row.createdAtMs,
  }
}
