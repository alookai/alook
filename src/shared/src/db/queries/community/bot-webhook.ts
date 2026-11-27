import { and, desc, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Database } from "../../index"
import { communityBotWebhook } from "../../community-bot-webhook-schema"
import {
  BOT_WEBHOOK_DELIVERY_LIST_DEFAULT,
  BOT_WEBHOOK_DELIVERY_RETENTION,
  BOT_WEBHOOK_MAX_PER_BOT,
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
  tokenHash: string
  signingSecretEnc: string | null
  eventFilter: string[] | null
  instruction: string
  enabled: boolean
  lastTriggeredAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
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
    tokenHash: row.tokenHash,
    signingSecretEnc: row.signingSecretEnc ?? null,
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
    tokenHash: string
    signingSecretEnc: string | null
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
  if (existing.length >= BOT_WEBHOOK_MAX_PER_BOT) {
    return { ok: false, code: "limit_exceeded" }
  }

  const nowMs = input.nowMs ?? Date.now()
  const id = `bwh_${nanoid(16)}`
  const eventFilterJson = input.eventFilter ? JSON.stringify(input.eventFilter) : null

  await db.insert(communityBotWebhook).values({
    id,
    ownerUserId: input.ownerUserId,
    botUserId: input.botUserId,
    name: input.name,
    provider: input.provider,
    tokenHash: input.tokenHash,
    signingSecretEnc: input.signingSecretEnc,
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
      tokenHash: input.tokenHash,
      signingSecretEnc: input.signingSecretEnc,
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
