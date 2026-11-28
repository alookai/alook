import { and, asc, desc, eq, inArray, notInArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import type { Database } from "../../index"
import { communityBotPrivateInbox } from "../../community-bot-private-inbox-schema"
import type {
  BotPrivateInboxSourceKind,
  BotPrivateInboxStatus,
} from "../../../bot-private-inbox"

export interface StoredBotPrivateInboxEvent {
  id: string
  ownerUserId: string
  botUserId: string
  sourceKind: BotPrivateInboxSourceKind
  sourceId: string
  sourceRefId: string | null
  dedupeKey: string | null
  eventType: string
  summary: string
  promptText: string
  status: BotPrivateInboxStatus
  lastError: string | null
  createdAtMs: number
  dispatchedAtMs: number | null
}

export interface StoredBotPrivateInboxSummary {
  id: string
  sourceId: string
  eventType: string
  summary: string
  status: BotPrivateInboxStatus
  lastError: string | null
  createdAtMs: number
}

function mapInboxRow(row: typeof communityBotPrivateInbox.$inferSelect): StoredBotPrivateInboxEvent {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    botUserId: row.botUserId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    sourceRefId: row.sourceRefId ?? null,
    dedupeKey: row.dedupeKey ?? null,
    eventType: row.eventType,
    summary: row.summary,
    promptText: row.promptText,
    status: row.status,
    lastError: row.lastError ?? null,
    createdAtMs: row.createdAtMs,
    dispatchedAtMs: row.dispatchedAtMs ?? null,
  }
}

export async function enqueuePrivateInboxEvent(
  db: Database,
  input: {
    id?: string
    ownerUserId: string
    botUserId: string
    sourceKind: BotPrivateInboxSourceKind
    sourceId: string
    sourceRefId?: string | null
    dedupeKey?: string | null
    eventType: string
    summary: string
    promptText: string
    status: BotPrivateInboxStatus
    lastError?: string | null
    nowMs?: number
    retentionLimit?: number
  },
): Promise<{ inserted: boolean; event: StoredBotPrivateInboxEvent }> {
  const nowMs = input.nowMs ?? Date.now()
  const id = input.id ?? `bpi_${nanoid(16)}`
  const dedupeKey = input.dedupeKey?.trim() || null
  const sourceRefId = input.sourceRefId?.trim() || null

  const insertedRows = await db
    .insert(communityBotPrivateInbox)
    .values({
      id,
      ownerUserId: input.ownerUserId,
      botUserId: input.botUserId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceRefId,
      dedupeKey,
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

  if (insertedRows.length === 0 && dedupeKey !== null) {
    const existing = await db
      .select()
      .from(communityBotPrivateInbox)
      .where(
        and(
          eq(communityBotPrivateInbox.sourceKind, input.sourceKind),
          eq(communityBotPrivateInbox.sourceId, input.sourceId),
          eq(communityBotPrivateInbox.dedupeKey, dedupeKey),
        ),
      )
      .limit(1)
    if (existing[0]) {
      return { inserted: false, event: mapInboxRow(existing[0]) }
    }
  }

  const event = insertedRows[0]
    ? mapInboxRow(insertedRows[0])
    : {
        id,
        ownerUserId: input.ownerUserId,
        botUserId: input.botUserId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceRefId,
        dedupeKey,
        eventType: input.eventType,
        summary: input.summary,
        promptText: input.promptText,
        status: input.status,
        lastError: input.lastError ?? null,
        createdAtMs: nowMs,
        dispatchedAtMs: input.status === "dispatched" ? nowMs : null,
      }

  if (input.retentionLimit && input.retentionLimit > 0) {
    const keep = await db
      .select({ id: communityBotPrivateInbox.id })
      .from(communityBotPrivateInbox)
      .where(
        and(
          eq(communityBotPrivateInbox.sourceKind, input.sourceKind),
          eq(communityBotPrivateInbox.sourceId, input.sourceId),
        ),
      )
      .orderBy(desc(communityBotPrivateInbox.createdAtMs), desc(communityBotPrivateInbox.id))
      .limit(input.retentionLimit)

    if (keep.length >= input.retentionLimit) {
      await db
        .delete(communityBotPrivateInbox)
        .where(
          and(
            eq(communityBotPrivateInbox.sourceKind, input.sourceKind),
            eq(communityBotPrivateInbox.sourceId, input.sourceId),
            notInArray(
              communityBotPrivateInbox.id,
              keep.map((row) => row.id),
            ),
          ),
        )
    }
  }

  return { inserted: true, event }
}

export async function getPrivateInboxEventById(
  db: Database,
  id: string,
): Promise<StoredBotPrivateInboxEvent | null> {
  const rows = await db
    .select()
    .from(communityBotPrivateInbox)
    .where(eq(communityBotPrivateInbox.id, id))
    .limit(1)
  return rows[0] ? mapInboxRow(rows[0]) : null
}

export async function updatePrivateInboxEventStatus(
  db: Database,
  id: string,
  patch: {
    status: BotPrivateInboxStatus
    lastError: string | null
    dispatchedAtMs?: number | null
    summary?: string
    promptText?: string
  },
): Promise<StoredBotPrivateInboxEvent | null> {
  const rows = await db
    .update(communityBotPrivateInbox)
    .set({
      status: patch.status,
      lastError: patch.lastError,
      ...(patch.dispatchedAtMs !== undefined ? { dispatchedAtMs: patch.dispatchedAtMs } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.promptText !== undefined ? { promptText: patch.promptText } : {}),
    })
    .where(eq(communityBotPrivateInbox.id, id))
    .returning()
  return rows[0] ? mapInboxRow(rows[0]) : null
}

export async function deletePendingPrivateInboxEventsForSource(
  db: Database,
  sourceKind: BotPrivateInboxSourceKind,
  sourceId: string,
): Promise<void> {
  await db
    .delete(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.sourceKind, sourceKind),
        eq(communityBotPrivateInbox.sourceId, sourceId),
        eq(communityBotPrivateInbox.status, "pending"),
      ),
    )
}

export async function deletePrivateInboxEventsForSource(
  db: Database,
  sourceKind: BotPrivateInboxSourceKind,
  sourceId: string,
): Promise<void> {
  await db
    .delete(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.sourceKind, sourceKind),
        eq(communityBotPrivateInbox.sourceId, sourceId),
      ),
    )
}

export async function listPrivateInboxEventsForSource(
  db: Database,
  ownerUserId: string,
  botUserId: string,
  sourceKind: BotPrivateInboxSourceKind,
  sourceId: string,
  limit: number,
): Promise<StoredBotPrivateInboxEvent[]> {
  const rows = await db
    .select()
    .from(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.sourceKind, sourceKind),
        eq(communityBotPrivateInbox.sourceId, sourceId),
        eq(communityBotPrivateInbox.ownerUserId, ownerUserId),
        eq(communityBotPrivateInbox.botUserId, botUserId),
      ),
    )
    .orderBy(desc(communityBotPrivateInbox.createdAtMs), desc(communityBotPrivateInbox.id))
    .limit(limit)
  return rows.map(mapInboxRow)
}

export async function getLatestPrivateInboxEventForSource(
  db: Database,
  sourceKind: BotPrivateInboxSourceKind,
  sourceId: string,
): Promise<StoredBotPrivateInboxSummary | null> {
  const rows = await db
    .select({
      id: communityBotPrivateInbox.id,
      sourceId: communityBotPrivateInbox.sourceId,
      eventType: communityBotPrivateInbox.eventType,
      summary: communityBotPrivateInbox.summary,
      status: communityBotPrivateInbox.status,
      lastError: communityBotPrivateInbox.lastError,
      createdAtMs: communityBotPrivateInbox.createdAtMs,
    })
    .from(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.sourceKind, sourceKind),
        eq(communityBotPrivateInbox.sourceId, sourceId),
      ),
    )
    .orderBy(desc(communityBotPrivateInbox.createdAtMs), desc(communityBotPrivateInbox.id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    sourceId: row.sourceId,
    eventType: row.eventType,
    summary: row.summary,
    status: row.status,
    lastError: row.lastError ?? null,
    createdAtMs: row.createdAtMs,
  }
}

export async function getLatestPrivateInboxEventsBySources(
  db: Database,
  sourceKind: BotPrivateInboxSourceKind,
  sourceIds: string[],
): Promise<Record<string, StoredBotPrivateInboxSummary>> {
  const result: Record<string, StoredBotPrivateInboxSummary> = {}
  if (sourceIds.length === 0) return result

  const rows = await db
    .select({
      id: communityBotPrivateInbox.id,
      sourceId: communityBotPrivateInbox.sourceId,
      eventType: communityBotPrivateInbox.eventType,
      summary: communityBotPrivateInbox.summary,
      status: communityBotPrivateInbox.status,
      lastError: communityBotPrivateInbox.lastError,
      createdAtMs: communityBotPrivateInbox.createdAtMs,
    })
    .from(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.sourceKind, sourceKind),
        inArray(communityBotPrivateInbox.sourceId, sourceIds),
      ),
    )
    .orderBy(desc(communityBotPrivateInbox.createdAtMs), desc(communityBotPrivateInbox.id))

  for (const row of rows) {
    if (result[row.sourceId] === undefined) {
      result[row.sourceId] = {
        id: row.id,
        sourceId: row.sourceId,
        eventType: row.eventType,
        summary: row.summary,
        status: row.status,
        lastError: row.lastError ?? null,
        createdAtMs: row.createdAtMs,
      }
    }
  }
  return result
}

export async function listPendingPrivateInboxEventsForBot(
  db: Database,
  botUserId: string,
  limit: number,
): Promise<StoredBotPrivateInboxEvent[]> {
  const rows = await db
    .select()
    .from(communityBotPrivateInbox)
    .where(
      and(
        eq(communityBotPrivateInbox.botUserId, botUserId),
        eq(communityBotPrivateInbox.status, "pending"),
      ),
    )
    .orderBy(asc(communityBotPrivateInbox.createdAtMs), asc(communityBotPrivateInbox.id))
    .limit(limit)
  return rows.map(mapInboxRow)
}
