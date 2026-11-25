import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as coreSchema from "../../schema"
import * as communitySchema from "../../community-schema"
import * as machineSchema from "../../community-machine-schema"
import * as scheduleSchema from "../../community-schedule-schema"
import type { Database } from "../../index"
import {
  claimDueEventOccurrence,
  createScheduleEvent,
  deleteScheduleEvent,
  getEarliestNextRunMs,
  getScheduleEventById,
  getScheduleRunById,
  listDueEventsForOwner,
  listOwnerScheduleEvents,
  listPendingRunsForOwner,
  updatePendingRunStatus,
  updateScheduleEvent,
} from "./schedule"

const schema = { ...coreSchema, ...communitySchema, ...machineSchema, ...scheduleSchema }
const migrationsDir = resolve(import.meta.dirname, "../../../../../web/migrations")

function createMigratedSqlite(): Sqlite.Database {
  const sqlite = new Sqlite(":memory:")
  sqlite.pragma("foreign_keys = ON")
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
  for (const file of files) {
    sqlite.exec(readFileSync(resolve(migrationsDir, file), "utf8"))
  }
  return sqlite
}

describe("community schedule D1 queries", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = createMigratedSqlite()
    db = drizzle(sqlite, { schema }) as unknown as Database
    const nowIso = "2026-11-25T00:00:00.000Z"
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_1", "gus", "gus@test.local", nowIso, nowIso, 0, null, "1813")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("bot_1", "Elwira", "bot1@test.local", nowIso, nowIso, 1, "owner_1", "8700")
    sqlite.prepare(
      `INSERT INTO user (id, name, email, emailVerified, avatarVersion, createdAt, updatedAt, isBot, ownerUserId, discriminator)
       VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?)`,
    ).run("owner_2", "other", "other@test.local", nowIso, nowIso, 0, null, "9999")
  })

  afterEach(() => sqlite.close())

  it("supports create, list, get, update metadata/schedule, claim, status transition, ack, delete, and owner isolation", async () => {
    const baseMs = Date.parse("2026-11-26T01:00:00.000Z")
    const created = await createScheduleEvent(db, {
      ownerUserId: "owner_1",
      createdByUserId: "bot_1",
      title: "Daily check",
      description: "Initial instructions",
      startAtMs: baseMs,
      durationMinutes: 30,
      timeZone: "UTC",
      recurrence: { freq: "daily", interval: 1 },
      sourceMessageId: "msg_1",
      sourceChannelId: "ch_1",
      nowMs: baseMs - 60_000,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.event.id).toMatch(/^sch_/)

    expect(await getScheduleEventById(db, "owner_2", created.event.id)).toBeNull()
    expect(await deleteScheduleEvent(db, "owner_2", created.event.id)).toBe(false)

    expect(await getEarliestNextRunMs(db, "owner_1")).toBe(baseMs)
    expect(await listDueEventsForOwner(db, "owner_1", baseMs - 1)).toEqual([])
    const due = await listDueEventsForOwner(db, "owner_1", baseMs)
    expect(due.map((e) => e.id)).toEqual([created.event.id])

    const claimedRun = await claimDueEventOccurrence(db, due[0]!, baseMs)
    expect(claimedRun).not.toBeNull()
    expect(claimedRun!.id).toMatch(/^srun_/)
    expect(claimedRun!.status).toBe("pending")
    expect(await getScheduleRunById(db, claimedRun!.id)).toMatchObject({ id: claimedRun!.id, status: "pending" })
    expect(await claimDueEventOccurrence(db, due[0]!, baseMs)).toBeNull()

    const metaUpdated = await updateScheduleEvent(db, "owner_1", created.event.id, {
      title: "Daily check v2",
      description: "Updated instructions",
      nowMs: baseMs + 1000,
    })
    expect(metaUpdated.ok).toBe(true)
    if (!metaUpdated.ok) return
    expect(metaUpdated.event.nextRunAtMs).toBe(baseMs + 86_400_000)
    expect(metaUpdated.latestRun?.titleSnapshot).toBe("Daily check v2")

    const pending = await listPendingRunsForOwner(db, "owner_1")
    expect(pending.map((r) => r.id)).toEqual([claimedRun!.id])
    expect(await updatePendingRunStatus(db, claimedRun!.id, {
      status: "dispatched",
      lastError: null,
      updatedAtMs: baseMs + 2000,
    })).toBe(true)
    expect(await listPendingRunsForOwner(db, "owner_1")).toEqual([])

    const acked = await updateScheduleEvent(db, "owner_1", created.event.id, {
      ack: true,
      nowMs: baseMs + 5000,
    })
    expect(acked.ok).toBe(true)
    if (!acked.ok) return
    expect(acked.latestRun?.status).toBe("completed")
    expect(acked.latestRun?.ackedAtMs).toBe(baseMs + 5000)
    expect(acked.event.nextRunAtMs).toBe(baseMs + 86_400_000)

    const reAcked = await updateScheduleEvent(db, "owner_1", created.event.id, {
      ack: true,
      nowMs: baseMs + 9000,
    })
    expect(reAcked.ok).toBe(true)
    if (!reAcked.ok) return
    expect(reAcked.latestRun?.ackedAtMs).toBe(baseMs + 5000)

    const listed = await listOwnerScheduleEvents(db, "owner_1", {
      creatorId: "bot_1",
      fromMs: baseMs - 3600_000,
      toMs: baseMs + 2 * 86_400_000,
    })
    expect(listed.events).toHaveLength(1)
    expect(listed.runsByEvent[created.event.id]).toHaveLength(1)
    expect(listed.latestRunByEvent[created.event.id]?.status).toBe("completed")

    const rescheduled = await updateScheduleEvent(db, "owner_1", created.event.id, {
      startAtMs: baseMs,
      recurrence: null,
      hasRecurrence: true,
      nowMs: baseMs + 9500,
    })
    expect(rescheduled.ok).toBe(true)
    if (!rescheduled.ok) return
    const conflictClaim = await claimDueEventOccurrence(db, rescheduled.event, baseMs + 9600)
    expect(conflictClaim?.id).toBe(claimedRun!.id)
    expect(await getEarliestNextRunMs(db, "owner_1")).toBeNull()

    expect(await deleteScheduleEvent(db, "owner_1", created.event.id)).toBe(true)
    expect(await getScheduleEventById(db, "owner_1", created.event.id)).toBeNull()
  })

  it("handles early ack on one-time events, rejects unfired recurring ack, and cascades on user delete", async () => {
    const futureMs = Date.parse("2026-11-27T01:00:00.000Z")
    const oneTime = await createScheduleEvent(db, {
      ownerUserId: "owner_1",
      createdByUserId: "bot_1",
      title: "One-off reminder",
      startAtMs: futureMs,
      timeZone: "UTC",
      recurrence: null,
      sourceMessageId: "msg_2",
      sourceChannelId: "ch_1",
      nowMs: futureMs - 3600_000,
    })
    expect(oneTime.ok).toBe(true)
    if (!oneTime.ok) return

    const earlyAck = await updateScheduleEvent(db, "owner_1", oneTime.event.id, {
      ack: true,
      nowMs: futureMs - 1000,
    })
    expect(earlyAck.ok).toBe(true)
    if (!earlyAck.ok) return
    expect(earlyAck.event.nextRunAtMs).toBeNull()
    expect(earlyAck.latestRun?.status).toBe("completed")
    expect(earlyAck.latestRun?.ackedAtMs).toBe(futureMs - 1000)

    const recurring = await createScheduleEvent(db, {
      ownerUserId: "owner_1",
      createdByUserId: "bot_1",
      title: "Unfired weekly",
      startAtMs: futureMs,
      timeZone: "UTC",
      recurrence: { freq: "weekly", interval: 1 },
      sourceMessageId: "msg_3",
      sourceChannelId: "ch_1",
      nowMs: futureMs - 3600_000,
    })
    expect(recurring.ok).toBe(true)
    if (!recurring.ok) return

    const rejectedAck = await updateScheduleEvent(db, "owner_1", recurring.event.id, {
      ack: true,
      nowMs: futureMs - 500,
    })
    expect(rejectedAck).toMatchObject({ ok: false, code: "conflict" })

    sqlite.prepare("DELETE FROM user WHERE id = ?").run("bot_1")
    const remaining = await listOwnerScheduleEvents(db, "owner_1")
    expect(remaining.events).toEqual([])
  })
})
