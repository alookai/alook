import { and, asc, desc, eq, gt, isNotNull, lt, lte } from "drizzle-orm"
import type { Database } from "../../index"
import { communityScheduleEvent, communityScheduleRun } from "../../community-schedule-schema"
import {
  advanceNextRunAfterFire,
  computeInitialNextRun,
  normalizeRecurrence,
  SCHEDULE_DEFAULT_DURATION_MINUTES,
  SCHEDULE_MAX_EVENTS_PER_OWNER,
  type ScheduleRecurrence,
  type ScheduleRunStatus,
} from "../../../schedule"

const RUNS_PER_EVENT_LIMIT = 200

export interface StoredScheduleEvent {
  id: string
  ownerUserId: string
  createdByUserId: string
  title: string
  description: string
  startAtMs: number
  durationMinutes: number
  timeZone: string
  recurrence: ScheduleRecurrence | null
  occurrenceCount: number
  nextRunAtMs: number | null
  sourceMessageId: string
  sourceChannelId: string
  version: number
  createdAtMs: number
  updatedAtMs: number
}

export interface StoredScheduleRun {
  id: string
  ownerUserId: string
  eventId: string
  eventVersion: number
  botUserId: string
  scheduledAtMs: number
  sourceMessageId: string
  sourceChannelId: string
  titleSnapshot: string
  descriptionSnapshot: string
  status: ScheduleRunStatus
  lastError: string | null
  ackedAtMs: number | null
  createdAtMs: number
  updatedAtMs: number
}

function mapEventRow(row: typeof communityScheduleEvent.$inferSelect): StoredScheduleEvent {
  let recurrence: ScheduleRecurrence | null = null
  if (row.recurrenceJson) {
    try {
      recurrence = normalizeRecurrence(JSON.parse(row.recurrenceJson) as ScheduleRecurrence)
    } catch {
      recurrence = null
    }
  }
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    description: row.description,
    startAtMs: row.startAtMs,
    durationMinutes: row.durationMinutes,
    timeZone: row.timeZone,
    recurrence,
    occurrenceCount: row.occurrenceCount,
    nextRunAtMs: row.nextRunAtMs,
    sourceMessageId: row.sourceMessageId,
    sourceChannelId: row.sourceChannelId,
    version: row.version,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  }
}

function mapRunRow(row: typeof communityScheduleRun.$inferSelect): StoredScheduleRun {
  const status: ScheduleRunStatus =
    row.status === "dispatched" || row.status === "completed" || row.status === "blocked_access"
      ? row.status
      : "pending"
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    eventId: row.eventId,
    eventVersion: row.eventVersion,
    botUserId: row.botUserId,
    scheduledAtMs: row.scheduledAtMs,
    sourceMessageId: row.sourceMessageId,
    sourceChannelId: row.sourceChannelId,
    titleSnapshot: row.titleSnapshot,
    descriptionSnapshot: row.descriptionSnapshot,
    status,
    lastError: row.lastError,
    ackedAtMs: row.ackedAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  }
}

export async function getLatestRunForEvent(
  db: Database,
  eventId: string,
): Promise<StoredScheduleRun | null> {
  const rows = await db
    .select()
    .from(communityScheduleRun)
    .where(eq(communityScheduleRun.eventId, eventId))
    .orderBy(desc(communityScheduleRun.scheduledAtMs))
    .limit(1)
  return rows[0] ? mapRunRow(rows[0]) : null
}

export async function listRunsForEventInRange(
  db: Database,
  eventId: string,
  minScheduledMsExclusive: number,
  maxScheduledMsExclusive: number,
  limit = RUNS_PER_EVENT_LIMIT,
): Promise<StoredScheduleRun[]> {
  const rows = await db
    .select()
    .from(communityScheduleRun)
    .where(
      and(
        eq(communityScheduleRun.eventId, eventId),
        gt(communityScheduleRun.scheduledAtMs, minScheduledMsExclusive),
        lt(communityScheduleRun.scheduledAtMs, maxScheduledMsExclusive),
      ),
    )
    .orderBy(asc(communityScheduleRun.scheduledAtMs))
    .limit(limit)
  return rows.map(mapRunRow)
}

export async function listOwnerScheduleEvents(
  db: Database,
  ownerUserId: string,
  opts: {
    creatorId?: string | null
    fromMs?: number | null
    toMs?: number | null
  } = {},
): Promise<{
  events: StoredScheduleEvent[]
  runsByEvent: Record<string, StoredScheduleRun[]>
  latestRunByEvent: Record<string, StoredScheduleRun | null>
}> {
  const rows = await db
    .select()
    .from(communityScheduleEvent)
    .where(eq(communityScheduleEvent.ownerUserId, ownerUserId))
    .orderBy(asc(communityScheduleEvent.createdAtMs))
    .limit(SCHEDULE_MAX_EVENTS_PER_OWNER)

  const creatorId = opts.creatorId ?? null
  const events = rows
    .map(mapEventRow)
    .filter((event) => !creatorId || event.createdByUserId === creatorId)
    .sort((a, b) => {
      const aKey = a.nextRunAtMs ?? a.startAtMs
      const bKey = b.nextRunAtMs ?? b.startAtMs
      return aKey - bKey || b.createdAtMs - a.createdAtMs
    })

  const runsByEvent: Record<string, StoredScheduleRun[]> = {}
  const latestRunByEvent: Record<string, StoredScheduleRun | null> = {}

  const hasRange =
    opts.fromMs !== undefined
    && opts.fromMs !== null
    && opts.toMs !== undefined
    && opts.toMs !== null
    && Number.isFinite(opts.fromMs)
    && Number.isFinite(opts.toMs)

  await Promise.all(
    events.map(async (event) => {
      const latest = await getLatestRunForEvent(db, event.id)
      latestRunByEvent[event.id] = latest
      if (hasRange) {
        const durationMs = event.durationMinutes * 60_000
        runsByEvent[event.id] = await listRunsForEventInRange(
          db,
          event.id,
          opts.fromMs! - durationMs,
          opts.toMs!,
        )
      }
    }),
  )

  return { events, runsByEvent, latestRunByEvent }
}

export async function getScheduleEventById(
  db: Database,
  ownerUserId: string,
  eventId: string,
): Promise<{ event: StoredScheduleEvent; latestRun: StoredScheduleRun | null } | null> {
  const rows = await db
    .select()
    .from(communityScheduleEvent)
    .where(
      and(
        eq(communityScheduleEvent.id, eventId),
        eq(communityScheduleEvent.ownerUserId, ownerUserId),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const latestRun = await getLatestRunForEvent(db, row.id)
  return { event: mapEventRow(row), latestRun }
}

export async function createScheduleEvent(
  db: Database,
  input: {
    ownerUserId: string
    createdByUserId: string
    title: string
    description?: string
    startAtMs: number
    durationMinutes?: number
    timeZone: string
    recurrence?: ScheduleRecurrence | null
    sourceMessageId: string
    sourceChannelId: string
    nowMs?: number
  },
): Promise<
  | { ok: true; event: StoredScheduleEvent; latestRun: null }
  | { ok: false; code: "limit_exceeded" }
> {
  const existingIds = await db
    .select({ id: communityScheduleEvent.id })
    .from(communityScheduleEvent)
    .where(eq(communityScheduleEvent.ownerUserId, input.ownerUserId))
    .limit(SCHEDULE_MAX_EVENTS_PER_OWNER)

  if (existingIds.length >= SCHEDULE_MAX_EVENTS_PER_OWNER) {
    return { ok: false, code: "limit_exceeded" }
  }

  const nowMs = input.nowMs ?? Date.now()
  const recurrence = normalizeRecurrence(input.recurrence ?? null)
  const durationMinutes = input.durationMinutes ?? SCHEDULE_DEFAULT_DURATION_MINUTES
  const initial = computeInitialNextRun(
    { startAtMs: input.startAtMs, timeZone: input.timeZone, recurrence },
    nowMs,
  )
  const id = `sch_${crypto.randomUUID()}`

  const inserted = await db
    .insert(communityScheduleEvent)
    .values({
      id,
      ownerUserId: input.ownerUserId,
      createdByUserId: input.createdByUserId,
      title: input.title,
      description: input.description ?? "",
      startAtMs: input.startAtMs,
      durationMinutes,
      timeZone: input.timeZone,
      recurrenceJson: recurrence ? JSON.stringify(recurrence) : null,
      occurrenceCount: initial.occurrenceCount,
      nextRunAtMs: initial.nextRunAtMs,
      sourceMessageId: input.sourceMessageId,
      sourceChannelId: input.sourceChannelId,
      version: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    })
    .returning()

  return { ok: true, event: mapEventRow(inserted[0]!), latestRun: null }
}

export async function updateScheduleEvent(
  db: Database,
  ownerUserId: string,
  eventId: string,
  patch: {
    title?: string
    description?: string
    startAtMs?: number
    durationMinutes?: number
    timeZone?: string
    hasRecurrence?: boolean
    recurrence?: ScheduleRecurrence | null
    sourceMessageId?: string
    sourceChannelId?: string
    ack?: true
    nowMs?: number
  },
): Promise<
  | { ok: true; event: StoredScheduleEvent; latestRun: StoredScheduleRun | null }
  | { ok: false; code: "not_found" | "conflict"; error: string }
> {
  const existingFound = await getScheduleEventById(db, ownerUserId, eventId)
  if (!existingFound) {
    return { ok: false, code: "not_found", error: "schedule event not found" }
  }

  const existing = existingFound.event
  let latestRun = existingFound.latestRun
  const nowMs = patch.nowMs ?? Date.now()

  const title = patch.title ?? existing.title
  const description = patch.description ?? existing.description
  const startAtMs = patch.startAtMs ?? existing.startAtMs
  const durationMinutes = patch.durationMinutes ?? existing.durationMinutes
  const timeZone = patch.timeZone ?? existing.timeZone
  const recurrence = patch.hasRecurrence
    ? normalizeRecurrence(patch.recurrence ?? null)
    : existing.recurrence
  const sourceMessageId = patch.sourceMessageId ?? existing.sourceMessageId
  const sourceChannelId = patch.sourceChannelId ?? existing.sourceChannelId

  const scheduleChanged =
    startAtMs !== existing.startAtMs
    || timeZone !== existing.timeZone
    || JSON.stringify(recurrence) !== JSON.stringify(existing.recurrence)

  const snapshotChanged =
    title !== existing.title
    || description !== existing.description
    || sourceMessageId !== existing.sourceMessageId
    || sourceChannelId !== existing.sourceChannelId

  const nextVersion = existing.version + 1
  let nextRunAtMs = existing.nextRunAtMs
  let occurrenceCount = existing.occurrenceCount

  if (scheduleChanged) {
    const recomputed = computeInitialNextRun(
      { startAtMs, timeZone, recurrence },
      nowMs,
    )
    nextRunAtMs = recomputed.nextRunAtMs
    occurrenceCount = recomputed.occurrenceCount
    await db
      .delete(communityScheduleRun)
      .where(
        and(
          eq(communityScheduleRun.eventId, eventId),
          eq(communityScheduleRun.status, "pending"),
        ),
      )
    if (latestRun?.status === "pending") {
      latestRun = await getLatestRunForEvent(db, eventId)
    }
  } else if (snapshotChanged) {
    await db
      .update(communityScheduleRun)
      .set({
        titleSnapshot: title,
        descriptionSnapshot: description,
        sourceMessageId,
        sourceChannelId,
        eventVersion: nextVersion,
        updatedAtMs: nowMs,
      })
      .where(
        and(
          eq(communityScheduleRun.eventId, eventId),
          eq(communityScheduleRun.status, "pending"),
        ),
      )
    if (latestRun?.status === "pending") {
      latestRun = await getLatestRunForEvent(db, eventId)
    }
  }

  if (patch.ack === true) {
    if (latestRun) {
      if (latestRun.status !== "completed") {
        const ackedRows = await db
          .update(communityScheduleRun)
          .set({
            status: "completed",
            lastError: null,
            ackedAtMs: nowMs,
            updatedAtMs: nowMs,
          })
          .where(eq(communityScheduleRun.id, latestRun.id))
          .returning()
        if (ackedRows[0]) latestRun = mapRunRow(ackedRows[0])
      }
      if (recurrence === null) {
        nextRunAtMs = null
        occurrenceCount = Math.max(occurrenceCount, 1)
      }
    } else if (recurrence === null) {
      const scheduledAtMs = nextRunAtMs ?? startAtMs
      nextRunAtMs = null
      occurrenceCount = Math.max(occurrenceCount, 1)
      const insertedRuns = await db
        .insert(communityScheduleRun)
        .values({
          id: `srun_${crypto.randomUUID()}`,
          ownerUserId,
          eventId,
          eventVersion: nextVersion,
          botUserId: existing.createdByUserId,
          scheduledAtMs,
          sourceMessageId,
          sourceChannelId,
          titleSnapshot: title,
          descriptionSnapshot: description,
          status: "completed",
          lastError: null,
          ackedAtMs: nowMs,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoNothing({
          target: [communityScheduleRun.eventId, communityScheduleRun.scheduledAtMs],
        })
        .returning()
      latestRun = insertedRuns[0] ? mapRunRow(insertedRuns[0]) : await getLatestRunForEvent(db, eventId)
    } else {
      return {
        ok: false,
        code: "conflict",
        error: "cannot acknowledge a recurring schedule event before it has triggered",
      }
    }
  }

  const updatedRows = await db
    .update(communityScheduleEvent)
    .set({
      title,
      description,
      startAtMs,
      durationMinutes,
      timeZone,
      recurrenceJson: recurrence ? JSON.stringify(recurrence) : null,
      occurrenceCount,
      nextRunAtMs,
      sourceMessageId,
      sourceChannelId,
      version: nextVersion,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(communityScheduleEvent.id, eventId),
        eq(communityScheduleEvent.ownerUserId, ownerUserId),
      ),
    )
    .returning()

  if (!updatedRows[0]) {
    return { ok: false, code: "not_found", error: "schedule event not found" }
  }

  const finalLatest = latestRun ?? await getLatestRunForEvent(db, eventId)
  return { ok: true, event: mapEventRow(updatedRows[0]), latestRun: finalLatest }
}

export async function deleteScheduleEvent(
  db: Database,
  ownerUserId: string,
  eventId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(communityScheduleEvent)
    .where(
      and(
        eq(communityScheduleEvent.id, eventId),
        eq(communityScheduleEvent.ownerUserId, ownerUserId),
      ),
    )
    .returning({ id: communityScheduleEvent.id })
  return deleted.length > 0
}

export async function getEarliestNextRunMs(
  db: Database,
  ownerUserId: string,
): Promise<number | null> {
  const rows = await db
    .select({ nextRunAtMs: communityScheduleEvent.nextRunAtMs })
    .from(communityScheduleEvent)
    .where(
      and(
        eq(communityScheduleEvent.ownerUserId, ownerUserId),
        isNotNull(communityScheduleEvent.nextRunAtMs),
      ),
    )
    .orderBy(asc(communityScheduleEvent.nextRunAtMs))
    .limit(1)
  return rows[0]?.nextRunAtMs ?? null
}

export async function listDueEventsForOwner(
  db: Database,
  ownerUserId: string,
  nowMs: number,
  limit = 25,
): Promise<StoredScheduleEvent[]> {
  const rows = await db
    .select()
    .from(communityScheduleEvent)
    .where(
      and(
        eq(communityScheduleEvent.ownerUserId, ownerUserId),
        isNotNull(communityScheduleEvent.nextRunAtMs),
        lte(communityScheduleEvent.nextRunAtMs, nowMs),
      ),
    )
    .orderBy(asc(communityScheduleEvent.nextRunAtMs))
    .limit(limit)
  return rows.map(mapEventRow)
}

export async function claimDueEventOccurrence(
  db: Database,
  event: StoredScheduleEvent,
  nowMs: number,
): Promise<StoredScheduleRun | null> {
  const scheduledAtMs = event.nextRunAtMs
  if (scheduledAtMs === null) return null

  const advanced = advanceNextRunAfterFire(
    { startAtMs: event.startAtMs, timeZone: event.timeZone, recurrence: event.recurrence },
    scheduledAtMs,
    event.occurrenceCount + 1,
    nowMs,
  )

  const claimed = await db
    .update(communityScheduleEvent)
    .set({
      nextRunAtMs: advanced.nextRunAtMs,
      occurrenceCount: advanced.occurrenceCount,
      version: event.version + 1,
      updatedAtMs: nowMs,
    })
    .where(
      and(
        eq(communityScheduleEvent.id, event.id),
        eq(communityScheduleEvent.ownerUserId, event.ownerUserId),
        eq(communityScheduleEvent.version, event.version),
        eq(communityScheduleEvent.nextRunAtMs, scheduledAtMs),
      ),
    )
    .returning({ id: communityScheduleEvent.id })

  if (claimed.length === 0) return null

  const inserted = await db
    .insert(communityScheduleRun)
    .values({
      id: `srun_${crypto.randomUUID()}`,
      ownerUserId: event.ownerUserId,
      eventId: event.id,
      eventVersion: event.version,
      botUserId: event.createdByUserId,
      scheduledAtMs,
      sourceMessageId: event.sourceMessageId,
      sourceChannelId: event.sourceChannelId,
      titleSnapshot: event.title,
      descriptionSnapshot: event.description,
      status: "pending",
      lastError: null,
      ackedAtMs: null,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    })
    .onConflictDoNothing({
      target: [communityScheduleRun.eventId, communityScheduleRun.scheduledAtMs],
    })
    .returning()

  if (inserted[0]) return mapRunRow(inserted[0])

  const existing = await db
    .select()
    .from(communityScheduleRun)
    .where(
      and(
        eq(communityScheduleRun.eventId, event.id),
        eq(communityScheduleRun.scheduledAtMs, scheduledAtMs),
      ),
    )
    .limit(1)
  return existing[0] ? mapRunRow(existing[0]) : null
}

export async function getScheduleRunById(
  db: Database,
  runId: string,
): Promise<StoredScheduleRun | null> {
  const rows = await db
    .select()
    .from(communityScheduleRun)
    .where(eq(communityScheduleRun.id, runId))
    .limit(1)
  return rows[0] ? mapRunRow(rows[0]) : null
}

export async function listPendingRunsForOwner(
  db: Database,
  ownerUserId: string,
  limit = 50,
): Promise<StoredScheduleRun[]> {
  const rows = await db
    .select()
    .from(communityScheduleRun)
    .where(
      and(
        eq(communityScheduleRun.ownerUserId, ownerUserId),
        eq(communityScheduleRun.status, "pending"),
      ),
    )
    .orderBy(asc(communityScheduleRun.scheduledAtMs))
    .limit(limit)
  return rows.map(mapRunRow)
}

export async function updatePendingRunStatus(
  db: Database,
  runId: string,
  next: {
    status: "pending" | "dispatched" | "blocked_access"
    lastError: string | null
    updatedAtMs: number
  },
): Promise<boolean> {
  const updated = await db
    .update(communityScheduleRun)
    .set({
      status: next.status,
      lastError: next.lastError,
      updatedAtMs: next.updatedAtMs,
    })
    .where(
      and(
        eq(communityScheduleRun.id, runId),
        eq(communityScheduleRun.status, "pending"),
      ),
    )
    .returning({ id: communityScheduleRun.id })
  return updated.length > 0
}
