import { and, asc, desc, eq, gte, inArray, notInArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Database } from "../../index"
import { communityBotWebhook, communityBotWebhookDelivery } from "../../community-bot-webhook-schema"
import {
  BOT_WEBHOOK_DELIVERY_LIST_DEFAULT,
  BOT_WEBHOOK_DELIVERY_RETENTION,
  BOT_WEBHOOK_MAX_PER_BOT,
  type BotWebhookDeliveryStatus,
  type BotWebhookProvider,
} from "../../../bot-webhook"

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

export interface StoredBotWebhookDelivery {
  id: string
  webhookId: string
  ownerUserId: string
  botUserId: string
  externalDeliveryId: string | null
  eventType: string
  summary: string
  promptText: string
  status: BotWebhookDeliveryStatus
  lastError: string | null
  createdAtMs: number
  dispatchedAtMs: number | null
}

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

function mapDeliveryRow(row: typeof communityBotWebhookDelivery.$inferSelect): StoredBotWebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    ownerUserId: row.ownerUserId,
    botUserId: row.botUserId,
    externalDeliveryId: row.externalDeliveryId ?? null,
    eventType: row.eventType,
    summary: row.summary,
    promptText: row.promptText,
    status: row.status,
    lastError: row.lastError ?? null,
    createdAtMs: row.createdAtMs,
    dispatchedAtMs: row.dispatchedAtMs ?? null,
  }
}

export interface StoredBotWebhookLastDelivery {
  id: string
  webhookId: string
  eventType: string
  summary: string
  status: BotWebhookDeliveryStatus
  lastError: string | null
  createdAtMs: number
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
  const lastDeliveryByWebhookId: Record<string, StoredBotWebhookLastDelivery> = {}
  if (webhooks.length === 0) {
    return { webhooks, lastDeliveryByWebhookId }
  }

  const webhookIds = webhooks.map((w) => w.id)
  const deliveries = await db
    .select({
      id: communityBotWebhookDelivery.id,
      webhookId: communityBotWebhookDelivery.webhookId,
      eventType: communityBotWebhookDelivery.eventType,
      summary: communityBotWebhookDelivery.summary,
      status: communityBotWebhookDelivery.status,
      lastError: communityBotWebhookDelivery.lastError,
      createdAtMs: communityBotWebhookDelivery.createdAtMs,
    })
    .from(communityBotWebhookDelivery)
    .where(inArray(communityBotWebhookDelivery.webhookId, webhookIds))
    .orderBy(desc(communityBotWebhookDelivery.createdAtMs), desc(communityBotWebhookDelivery.id))

  for (const row of deliveries) {
    if (lastDeliveryByWebhookId[row.webhookId] === undefined) {
      lastDeliveryByWebhookId[row.webhookId] = {
        id: row.id,
        webhookId: row.webhookId,
        eventType: row.eventType,
        summary: row.summary,
        status: row.status,
        lastError: row.lastError ?? null,
        createdAtMs: row.createdAtMs,
      }
    }
  }

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
): Promise<StoredBotWebhookDelivery | null> {
  const rows = await db
    .select()
    .from(communityBotWebhookDelivery)
    .where(eq(communityBotWebhookDelivery.webhookId, webhookId))
    .orderBy(desc(communityBotWebhookDelivery.createdAtMs), desc(communityBotWebhookDelivery.id))
    .limit(1)
  return rows[0] ? mapDeliveryRow(rows[0]) : null
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
  return rows.length > 0
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
  const id = input.id ?? `whd_${nanoid(16)}`
  const externalDeliveryId = input.externalDeliveryId?.trim() || null

  const insertedRows = await db
    .insert(communityBotWebhookDelivery)
    .values({
      id,
      webhookId: input.webhookId,
      ownerUserId: input.ownerUserId,
      botUserId: input.botUserId,
      externalDeliveryId,
      eventType: input.eventType,
      summary: input.summary,
      promptText: input.promptText,
      status: input.status,
      lastError: input.lastError ?? null,
      createdAtMs: nowMs,
      dispatchedAtMs: input.status === "dispatched" ? nowMs : null,
    })
    .onConflictDoNothing()
    .returning()

  if (insertedRows.length === 0 && externalDeliveryId !== null) {
    const existing = await db
      .select()
      .from(communityBotWebhookDelivery)
      .where(
        and(
          eq(communityBotWebhookDelivery.webhookId, input.webhookId),
          eq(communityBotWebhookDelivery.externalDeliveryId, externalDeliveryId),
        ),
      )
      .limit(1)
    if (existing[0]) {
      return { inserted: false, delivery: mapDeliveryRow(existing[0]) }
    }
  }

  const delivery = insertedRows[0]
    ? mapDeliveryRow(insertedRows[0])
    : {
        id,
        webhookId: input.webhookId,
        ownerUserId: input.ownerUserId,
        botUserId: input.botUserId,
        externalDeliveryId,
        eventType: input.eventType,
        summary: input.summary,
        promptText: input.promptText,
        status: input.status,
        lastError: input.lastError ?? null,
        createdAtMs: nowMs,
        dispatchedAtMs: input.status === "dispatched" ? nowMs : null,
      }

  await db
    .update(communityBotWebhook)
    .set({ lastTriggeredAtMs: nowMs })
    .where(eq(communityBotWebhook.id, input.webhookId))

  const keep = await db
    .select({ id: communityBotWebhookDelivery.id })
    .from(communityBotWebhookDelivery)
    .where(eq(communityBotWebhookDelivery.webhookId, input.webhookId))
    .orderBy(desc(communityBotWebhookDelivery.createdAtMs), desc(communityBotWebhookDelivery.id))
    .limit(BOT_WEBHOOK_DELIVERY_RETENTION)

  if (keep.length >= BOT_WEBHOOK_DELIVERY_RETENTION) {
    await db
      .delete(communityBotWebhookDelivery)
      .where(
        and(
          eq(communityBotWebhookDelivery.webhookId, input.webhookId),
          notInArray(
            communityBotWebhookDelivery.id,
            keep.map((row) => row.id),
          ),
        ),
      )
  }

  return { inserted: true, delivery }
}

export async function updateBotWebhookDeliveryStatus(
  db: Database,
  deliveryId: string,
  patch: {
    status: BotWebhookDeliveryStatus
    lastError: string | null
    dispatchedAtMs?: number | null
  },
): Promise<StoredBotWebhookDelivery | null> {
  const rows = await db
    .update(communityBotWebhookDelivery)
    .set({
      status: patch.status,
      lastError: patch.lastError,
      ...(patch.dispatchedAtMs !== undefined ? { dispatchedAtMs: patch.dispatchedAtMs } : {}),
    })
    .where(eq(communityBotWebhookDelivery.id, deliveryId))
    .returning()
  return rows[0] ? mapDeliveryRow(rows[0]) : null
}

export async function listBotWebhookDeliveries(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  webhookId: string,
  limit = BOT_WEBHOOK_DELIVERY_LIST_DEFAULT,
): Promise<StoredBotWebhookDelivery[]> {
  const rows = await db
    .select()
    .from(communityBotWebhookDelivery)
    .where(
      and(
        eq(communityBotWebhookDelivery.webhookId, webhookId),
        eq(communityBotWebhookDelivery.ownerUserId, ownerUserId),
        eq(communityBotWebhookDelivery.botUserId, botUserId),
      ),
    )
    .orderBy(desc(communityBotWebhookDelivery.createdAtMs), desc(communityBotWebhookDelivery.id))
    .limit(limit)
  return rows.map(mapDeliveryRow)
}

export async function listPendingBotWebhookDeliveriesForBot(
  db: Database,
  botUserId: string,
  opts: { sinceMs: number; limit: number },
): Promise<StoredBotWebhookDelivery[]> {
  const rows = await db
    .select()
    .from(communityBotWebhookDelivery)
    .where(
      and(
        eq(communityBotWebhookDelivery.botUserId, botUserId),
        eq(communityBotWebhookDelivery.status, "pending"),
        gte(communityBotWebhookDelivery.createdAtMs, opts.sinceMs),
      ),
    )
    .orderBy(asc(communityBotWebhookDelivery.createdAtMs), asc(communityBotWebhookDelivery.id))
    .limit(opts.limit)
  return rows.map(mapDeliveryRow)
}
