import { DurableObject } from "cloudflare:workers"
import {
  advanceNextRunAfterFire,
  CALENDAR_DEFAULT_DURATION_MINUTES,
  CALENDAR_MAX_EVENTS_PER_OWNER,
  computeFirstOccurrenceMs,
  createDb,
  createLogger,
  formatHandle,
  makeRuntimeConfig,
  normalizeRecurrence,
  queries,
  resolveModelConfig,
  withD1Retry,
  WS_EVENTS,
  type CalendarRecurrence,
  type CalendarRunStatus,
  type HostCommand,
} from "@alook/shared"
import { createInternalBrowserBroadcastRequest } from "./internal-user-broadcast"

const log = createLogger({ service: "owner-calendar-do" })

const ALARM_EVENT_BATCH_LIMIT = 25
const RESYNC_RUN_BATCH_LIMIT = 50
const RUNS_PER_EVENT_LIMIT = 200

interface StoredCalendarEvent {
  id: string
  ownerUserId: string
  createdByUserId: string
  title: string
  description: string
  startAtMs: number
  durationMinutes: number
  timeZone: string
  recurrence: CalendarRecurrence | null
  occurrenceCount: number
  nextRunAtMs: number | null
  paused: boolean
  sourceMessageId: string
  sourceChannelId: string
  version: number
  createdAtMs: number
  updatedAtMs: number
}

interface StoredCalendarRun {
  id: string
  eventId: string
  eventVersion: number
  botUserId: string
  scheduledAtMs: number
  sourceMessageId: string
  sourceChannelId: string
  titleSnapshot: string
  descriptionSnapshot: string
  status: CalendarRunStatus
  lastError: string | null
  createdAtMs: number
  updatedAtMs: number
}

type EventRow = {
  id: string
  owner_user_id: string
  created_by_user_id: string
  title: string
  description: string
  start_at_ms: number
  duration_minutes: number
  time_zone: string
  recurrence_json: string | null
  occurrence_count: number
  next_run_at_ms: number | null
  paused: number
  source_message_id: string
  source_channel_id: string
  version: number
  created_at_ms: number
  updated_at_ms: number
}

type RunRow = {
  id: string
  event_id: string
  event_version: number
  bot_user_id: string
  scheduled_at_ms: number
  source_message_id: string
  source_channel_id: string
  title_snapshot: string
  description_snapshot: string
  status: string
  last_error: string | null
  created_at_ms: number
  updated_at_ms: number
}

function mapEventRow(row: EventRow): StoredCalendarEvent {
  let recurrence: CalendarRecurrence | null = null
  if (row.recurrence_json) {
    try {
      recurrence = normalizeRecurrence(JSON.parse(row.recurrence_json) as CalendarRecurrence)
    } catch {
      recurrence = null
    }
  }
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    description: row.description,
    startAtMs: row.start_at_ms,
    durationMinutes: row.duration_minutes,
    timeZone: row.time_zone,
    recurrence,
    occurrenceCount: row.occurrence_count,
    nextRunAtMs: row.next_run_at_ms,
    paused: row.paused === 1,
    sourceMessageId: row.source_message_id,
    sourceChannelId: row.source_channel_id,
    version: row.version,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function mapRunRow(row: RunRow): StoredCalendarRun {
  const status: CalendarRunStatus =
    row.status === "dispatched" || row.status === "blocked_access" ? row.status : "pending"
  return {
    id: row.id,
    eventId: row.event_id,
    eventVersion: row.event_version,
    botUserId: row.bot_user_id,
    scheduledAtMs: row.scheduled_at_ms,
    sourceMessageId: row.source_message_id,
    sourceChannelId: row.source_channel_id,
    titleSnapshot: row.title_snapshot,
    descriptionSnapshot: row.description_snapshot,
    status,
    lastError: row.last_error,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  }
}

function computeInitialNextRun(
  spec: { startAtMs: number; timeZone: string; recurrence: CalendarRecurrence | null },
  paused: boolean,
  nowMs: number,
): { nextRunAtMs: number | null; occurrenceCount: number } {
  if (paused) return { nextRunAtMs: null, occurrenceCount: 0 }
  const first = computeFirstOccurrenceMs(spec)
  if (first === null) return { nextRunAtMs: null, occurrenceCount: 0 }
  if (!spec.recurrence || first >= nowMs - 60_000) {
    return { nextRunAtMs: first, occurrenceCount: 0 }
  }
  return advanceNextRunAfterFire(spec, first, 1, nowMs)
}

function buildCalendarEventPrompt(input: {
  eventId: string
  title: string
  description: string
  scheduledAtMs: number
  channelRef: string
  seq: number
  channelType: string | null
}): string {
  const isForumOpener = input.channelType === "forum"
  const replyTarget = isForumOpener ? `${input.channelRef}/#${input.seq}` : input.channelRef
  const replyCommand = isForumOpener
    ? `$ALOOK_CLI message send --target "${replyTarget}" --remind-after 0 --stdin`
    : `$ALOOK_CLI message send --target "${input.channelRef}" --reply "#${input.seq}" --remind-after 0 --stdin`
  const historyCommand = isForumOpener
    ? `$ALOOK_CLI channel history --channel "${replyTarget}" --limit 10`
    : `$ALOOK_CLI channel history --channel "${input.channelRef}" --around ${input.seq} --limit 5`

  const lines = [
    "[Scheduled Calendar Event — Execute Now]",
    `Event: ${input.title} (${input.eventId})`,
    `Scheduled time (UTC): ${new Date(input.scheduledAtMs).toISOString()}`,
    `Bound message: ${input.channelRef}#${input.seq}`,
  ]
  if (input.description.trim().length > 0) {
    lines.push("Instructions:", input.description.trim())
  }
  lines.push(
    `Execute this scheduled task now. Do not merely check whether the schedule exists.`,
    `Inspect context if needed: ${historyCommand}`,
    `Reply to the bound conversation with: ${replyCommand}`,
  )
  return lines.join("\n")
}

export class OwnerCalendarDurableObject extends DurableObject<Env> {
  private schemaReady = false
  private readonly inFlightRuns = new Set<string>()

  private ensureSchema(): void {
    if (this.schemaReady) return
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        start_at_ms INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        recurrence_json TEXT,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        next_run_at_ms INTEGER,
        paused INTEGER NOT NULL DEFAULT 0,
        source_message_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_events_next_run
        ON calendar_events (next_run_at_ms)
        WHERE paused = 0 AND next_run_at_ms IS NOT NULL;
      CREATE TABLE IF NOT EXISTS calendar_runs (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_version INTEGER NOT NULL,
        bot_user_id TEXT NOT NULL,
        scheduled_at_ms INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        source_channel_id TEXT NOT NULL,
        title_snapshot TEXT NOT NULL,
        description_snapshot TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE (event_id, scheduled_at_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_calendar_runs_bot_status
        ON calendar_runs (bot_user_id, status, scheduled_at_ms);
      CREATE INDEX IF NOT EXISTS idx_calendar_runs_event_scheduled
        ON calendar_runs (event_id, scheduled_at_ms DESC);
    `)
    this.schemaReady = true
  }

  private queryEarliestNextRunMs(): number | null {
    const row = this.ctx.storage.sql.exec<{ next_ms: number | null }>(
      "SELECT MIN(next_run_at_ms) AS next_ms FROM calendar_events WHERE paused = 0 AND next_run_at_ms IS NOT NULL",
    ).one()
    return typeof row.next_ms === "number" ? row.next_ms : null
  }

  private async applyAlarm(nextAlarmMs: number | null, nowMs: number): Promise<void> {
    if (nextAlarmMs !== null) {
      await this.ctx.storage.setAlarm(Math.max(nextAlarmMs, nowMs))
    } else {
      await this.ctx.storage.deleteAlarm()
    }
  }

  private async notifyOwnerChanged(
    ownerUserId: string,
    eventId: string,
    reason: "created" | "updated" | "deleted" | "run_updated",
  ): Promise<void> {
    try {
      const doId = this.env.WS_DO.idFromName("user:" + ownerUserId)
      const stub = this.env.WS_DO.get(doId)
      await stub.fetch(
        createInternalBrowserBroadcastRequest(ownerUserId, {
          type: WS_EVENTS.CALENDAR_CHANGED,
          eventId,
          reason,
        }),
      )
    } catch (err) {
      log.warn("calendar_owner_broadcast_failed", { ownerUserId, eventId, reason, err: String(err) })
    }
  }

  private async pushAgentEventToMachine(
    machineId: string,
    command: Extract<HostCommand, { type: "agent:event" }>,
  ): Promise<{ sent: number }> {
    const db = createDb(this.env.DB)
    const doNames = await withD1Retry(
      () => queries.communityMachine.getActiveDoNamesForMachine(db, machineId),
      { route: "owner-calendar:machine-do-names" },
    )
    if (doNames.length === 0) return { sent: 0 }

    const bodyText = JSON.stringify(command)
    let sent = 0
    for (const doName of doNames) {
      const doId = this.env.WS_DO.idFromName("community-machine:" + doName)
      const stub = this.env.WS_DO.get(doId)
      try {
        const res = await stub.fetch(
          new Request("http://internal/push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: bodyText,
          }),
        )
        if (!res.ok) continue
        const receipt = (await res.json()) as { sent?: unknown }
        if (typeof receipt.sent === "number" && Number.isSafeInteger(receipt.sent) && receipt.sent >= 0) {
          sent += receipt.sent
        }
      } catch (err) {
        log.warn("calendar_machine_push_failed", { machineId, doName, err: String(err) })
      }
    }
    return { sent }
  }

  private async dispatchPendingRun(
    run: StoredCalendarRun,
    ownerUserId: string,
  ): Promise<"dispatched" | "pending" | "blocked_access" | "skipped"> {
    if (this.inFlightRuns.has(run.id)) return "skipped"
    this.inFlightRuns.add(run.id)
    try {
      const current = this.ctx.storage.sql.exec<{ status: string }>(
        "SELECT status FROM calendar_runs WHERE id = ?",
        run.id,
      ).toArray()[0]
      if (!current || current.status !== "pending") return "skipped"

      const db = createDb(this.env.DB)
      const nowMs = Date.now()

      const markBlocked = async (reason: string): Promise<"blocked_access"> => {
        this.ctx.storage.sql.exec(
          "UPDATE calendar_runs SET status = 'blocked_access', last_error = ?, updated_at_ms = ? WHERE id = ? AND status = 'pending'",
          reason,
          nowMs,
          run.id,
        )
        await this.notifyOwnerChanged(ownerUserId, run.eventId, "run_updated")
        return "blocked_access"
      }

      const markPendingError = async (reason: string): Promise<"pending"> => {
        this.ctx.storage.sql.exec(
          "UPDATE calendar_runs SET last_error = ?, updated_at_ms = ? WHERE id = ? AND status = 'pending'",
          reason,
          nowMs,
          run.id,
        )
        await this.notifyOwnerChanged(ownerUserId, run.eventId, "run_updated")
        return "pending"
      }

      const botCtx = await withD1Retry(
        () => queries.communityBot.getBotWakeContext(db, run.botUserId),
        { route: "owner-calendar:bot-wake-context" },
      )
      if (botCtx.state !== "ready") {
        if (botCtx.state === "bot_unbound") return await markPendingError("bot_unbound")
        return await markBlocked(botCtx.state)
      }
      if (botCtx.ownerUserId !== ownerUserId) {
        return await markBlocked("owner_mismatch")
      }

      const msg = await withD1Retry(
        () => queries.communityMessage.getWakeMessageScopeById(db, run.sourceMessageId),
        { route: "owner-calendar:source-message" },
      )
      if (!msg) return await markBlocked("source_message_deleted")

      const canRead = await withD1Retry(
        () => queries.communityMember.canBotReadWakeScope(db, run.botUserId, { channelId: msg.channelId }),
        { route: "owner-calendar:source-message-access" },
      )
      if (!canRead) return await markBlocked("source_message_inaccessible")

      const channelRef = await withD1Retry(
        () => queries.communityAgentInbox.resolveUnreadNoticeChannel(db, { channelId: msg.channelId }, run.botUserId),
        { route: "owner-calendar:source-channel-ref" },
      )
      if (!channelRef) return await markBlocked("source_channel_unresolvable")

      const channelType = await withD1Retry(
        () => queries.communityChannel.getChannelType(db, msg.channelId),
        { route: "owner-calendar:source-channel-type" },
      )

      const prompt = buildCalendarEventPrompt({
        eventId: run.eventId,
        title: run.titleSnapshot,
        description: run.descriptionSnapshot,
        scheduledAtMs: run.scheduledAtMs,
        channelRef,
        seq: msg.seq,
        channelType,
      })

      const command: Extract<HostCommand, { type: "agent:event" }> = {
        type: "agent:event",
        agentId: botCtx.botUserId,
        config: makeRuntimeConfig({
          runtime: botCtx.runtime,
          model: resolveModelConfig(botCtx.modelName),
          reasoningEffort: botCtx.reasoningEffort ?? undefined,
          runtimeConfigRevision: botCtx.runtimeConfigRevision,
          agentName: botCtx.name,
          agentHandle: `@${formatHandle(botCtx.name, botCtx.discriminator)}`,
        }),
        launchId: `calrun_${run.id}`,
        prompt,
      }

      const { sent } = await this.pushAgentEventToMachine(botCtx.machineId, command)
      if (sent > 0) {
        this.ctx.storage.sql.exec(
          "UPDATE calendar_runs SET status = 'dispatched', last_error = NULL, updated_at_ms = ? WHERE id = ? AND status = 'pending'",
          Date.now(),
          run.id,
        )
        await this.notifyOwnerChanged(ownerUserId, run.eventId, "run_updated")
        return "dispatched"
      }

      return await markPendingError("machine_offline")
    } catch (err) {
      log.warn("calendar_run_dispatch_failed", { runId: run.id, eventId: run.eventId, err: String(err) })
      return "pending"
    } finally {
      this.inFlightRuns.delete(run.id)
    }
  }

  async alarm(): Promise<void> {
    this.ensureSchema()
    const nowMs = Date.now()

    // Phase 1: commit due runs + next occurrence advancement atomically before any external I/O.
    const committed = this.ctx.storage.transactionSync(() => {
      const dueRows = this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM calendar_events WHERE paused = 0 AND next_run_at_ms IS NOT NULL AND next_run_at_ms <= ? ORDER BY next_run_at_ms ASC LIMIT ?",
        nowMs,
        ALARM_EVENT_BATCH_LIMIT,
      ).toArray()

      const runsToDispatch: Array<{ run: StoredCalendarRun; ownerUserId: string }> = []

      for (const row of dueRows) {
        const event = mapEventRow(row)
        const scheduledAtMs = event.nextRunAtMs
        if (scheduledAtMs === null) continue

        const runId = `crun_${crypto.randomUUID()}`
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO calendar_runs (
            id, event_id, event_version, bot_user_id, scheduled_at_ms,
            source_message_id, source_channel_id, title_snapshot, description_snapshot,
            status, last_error, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
          runId,
          event.id,
          event.version,
          event.createdByUserId,
          scheduledAtMs,
          event.sourceMessageId,
          event.sourceChannelId,
          event.title,
          event.description,
          nowMs,
          nowMs,
        )

        const persistedRunRow = this.ctx.storage.sql.exec<RunRow>(
          "SELECT * FROM calendar_runs WHERE event_id = ? AND scheduled_at_ms = ?",
          event.id,
          scheduledAtMs,
        ).toArray()[0]

        const nextCount = event.occurrenceCount + 1
        const advanced = advanceNextRunAfterFire(
          { startAtMs: event.startAtMs, timeZone: event.timeZone, recurrence: event.recurrence },
          scheduledAtMs,
          nextCount,
          nowMs,
        )

        this.ctx.storage.sql.exec(
          "UPDATE calendar_events SET next_run_at_ms = ?, occurrence_count = ?, updated_at_ms = ? WHERE id = ?",
          advanced.nextRunAtMs,
          advanced.occurrenceCount,
          nowMs,
          event.id,
        )

        if (persistedRunRow) {
          const run = mapRunRow(persistedRunRow)
          if (run.status === "pending") {
            runsToDispatch.push({ run, ownerUserId: event.ownerUserId })
          }
        }
      }

      const nextAlarmMs = this.queryEarliestNextRunMs()
      return { runsToDispatch, nextAlarmMs }
    })

    await this.applyAlarm(committed.nextAlarmMs, nowMs)

    // Phase 2: best-effort post-commit dispatch — failures never throw out of alarm().
    for (const item of committed.runsToDispatch) {
      await this.dispatchPendingRun(item.run, item.ownerUserId)
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema()
    const url = new URL(request.url)

    if (url.pathname === "/events" && request.method === "GET") {
      return this.handleList(url)
    }
    if (url.pathname === "/events" && request.method === "POST") {
      return this.handleCreate(request)
    }
    const eventMatch = url.pathname.match(/^\/events\/([^/]+)$/)
    if (eventMatch && request.method === "GET") {
      return this.handleGetOne(decodeURIComponent(eventMatch[1]!))
    }
    if (eventMatch && request.method === "PATCH") {
      return this.handleUpdate(decodeURIComponent(eventMatch[1]!), request)
    }
    if (eventMatch && request.method === "DELETE") {
      return this.handleDelete(decodeURIComponent(eventMatch[1]!), request)
    }
    if (url.pathname === "/resync-bots" && request.method === "POST") {
      return this.handleResyncBots(request)
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }

  private handleList(url: URL): Response {
    const creatorId = url.searchParams.get("creatorId")
    const includePaused = url.searchParams.get("includePaused") !== "false"
    const fromMsRaw = url.searchParams.get("fromMs")
    const toMsRaw = url.searchParams.get("toMs")
    const fromMs = fromMsRaw !== null ? Number(fromMsRaw) : null
    const toMs = toMsRaw !== null ? Number(toMsRaw) : null

    const rows = this.ctx.storage.sql.exec<EventRow>(
      "SELECT * FROM calendar_events ORDER BY COALESCE(next_run_at_ms, start_at_ms) ASC, created_at_ms DESC",
    ).toArray()

    const events = rows
      .map(mapEventRow)
      .filter((event) => (includePaused || !event.paused))
      .filter((event) => (!creatorId || event.createdByUserId === creatorId))

    const runsByEvent: Record<string, StoredCalendarRun[]> = {}
    const latestRunByEvent: Record<string, StoredCalendarRun | null> = {}

    for (const event of events) {
      const latest = this.ctx.storage.sql.exec<RunRow>(
        "SELECT * FROM calendar_runs WHERE event_id = ? ORDER BY scheduled_at_ms DESC LIMIT 1",
        event.id,
      ).toArray()[0]
      latestRunByEvent[event.id] = latest ? mapRunRow(latest) : null

      if (fromMs !== null && toMs !== null && Number.isFinite(fromMs) && Number.isFinite(toMs)) {
        const durationMs = event.durationMinutes * 60_000
        const runRows = this.ctx.storage.sql.exec<RunRow>(
          "SELECT * FROM calendar_runs WHERE event_id = ? AND scheduled_at_ms > ? AND scheduled_at_ms < ? ORDER BY scheduled_at_ms ASC LIMIT ?",
          event.id,
          fromMs - durationMs,
          toMs,
          RUNS_PER_EVENT_LIMIT,
        ).toArray()
        runsByEvent[event.id] = runRows.map(mapRunRow)
      }
    }

    return Response.json({ events, runsByEvent, latestRunByEvent })
  }

  private handleGetOne(eventId: string): Response {
    const row = this.ctx.storage.sql.exec<EventRow>(
      "SELECT * FROM calendar_events WHERE id = ?",
      eventId,
    ).toArray()[0]
    if (!row) return Response.json({ error: "event not found" }, { status: 404 })
    const latest = this.ctx.storage.sql.exec<RunRow>(
      "SELECT * FROM calendar_runs WHERE event_id = ? ORDER BY scheduled_at_ms DESC LIMIT 1",
      eventId,
    ).toArray()[0]
    return Response.json({
      event: mapEventRow(row),
      latestRun: latest ? mapRunRow(latest) : null,
    })
  }

  private async handleCreate(request: Request): Promise<Response> {
    let body: {
      ownerUserId?: string
      createdByUserId?: string
      title?: string
      description?: string
      startAtMs?: number
      durationMinutes?: number
      timeZone?: string
      recurrence?: CalendarRecurrence | null
      sourceMessageId?: string
      sourceChannelId?: string
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }

    if (
      !body.ownerUserId
      || !body.createdByUserId
      || !body.title
      || typeof body.startAtMs !== "number"
      || !Number.isFinite(body.startAtMs)
      || !body.timeZone
      || !body.sourceMessageId
      || !body.sourceChannelId
    ) {
      return Response.json({ error: "missing required fields" }, { status: 400 })
    }

    const nowMs = Date.now()
    const recurrence = normalizeRecurrence(body.recurrence ?? null)
    const durationMinutes = body.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES
    const initial = computeInitialNextRun(
      { startAtMs: body.startAtMs, timeZone: body.timeZone, recurrence },
      false,
      nowMs,
    )
    const id = `cal_${crypto.randomUUID()}`

    const outcome = this.ctx.storage.transactionSync(() => {
      const countRow = this.ctx.storage.sql.exec<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM calendar_events",
      ).one()
      if ((countRow.cnt ?? 0) >= CALENDAR_MAX_EVENTS_PER_OWNER) {
        return { limitExceeded: true as const }
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO calendar_events (
          id, owner_user_id, created_by_user_id, title, description,
          start_at_ms, duration_minutes, time_zone, recurrence_json,
          occurrence_count, next_run_at_ms, paused,
          source_message_id, source_channel_id, version, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)`,
        id,
        body.ownerUserId!,
        body.createdByUserId!,
        body.title!,
        body.description ?? "",
        body.startAtMs!,
        durationMinutes,
        body.timeZone!,
        recurrence ? JSON.stringify(recurrence) : null,
        initial.occurrenceCount,
        initial.nextRunAtMs,
        body.sourceMessageId!,
        body.sourceChannelId!,
        nowMs,
        nowMs,
      )
      const row = this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM calendar_events WHERE id = ?",
        id,
      ).one()
      const nextAlarmMs = this.queryEarliestNextRunMs()
      return { limitExceeded: false as const, event: mapEventRow(row), nextAlarmMs }
    })

    if (outcome.limitExceeded) {
      return Response.json({ error: `calendar event limit reached (${CALENDAR_MAX_EVENTS_PER_OWNER})` }, { status: 409 })
    }

    await this.applyAlarm(outcome.nextAlarmMs, nowMs)
    await this.notifyOwnerChanged(outcome.event.ownerUserId, outcome.event.id, "created")
    return Response.json({ event: outcome.event, latestRun: null }, { status: 201 })
  }

  private async handleUpdate(eventId: string, request: Request): Promise<Response> {
    let body: {
      ownerUserId?: string
      title?: string
      description?: string
      startAtMs?: number
      durationMinutes?: number
      timeZone?: string
      recurrence?: CalendarRecurrence | null
      hasRecurrence?: boolean
      sourceMessageId?: string
      sourceChannelId?: string
      paused?: boolean
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }

    const nowMs = Date.now()
    const outcome = this.ctx.storage.transactionSync(() => {
      const existingRow = this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM calendar_events WHERE id = ?",
        eventId,
      ).toArray()[0]
      if (!existingRow) return { found: false as const }

      const existing = mapEventRow(existingRow)
      const title = body.title ?? existing.title
      const description = body.description ?? existing.description
      const startAtMs = body.startAtMs ?? existing.startAtMs
      const durationMinutes = body.durationMinutes ?? existing.durationMinutes
      const timeZone = body.timeZone ?? existing.timeZone
      const recurrence = body.hasRecurrence
        ? normalizeRecurrence(body.recurrence ?? null)
        : existing.recurrence
      const paused = body.paused ?? existing.paused
      const sourceMessageId = body.sourceMessageId ?? existing.sourceMessageId
      const sourceChannelId = body.sourceChannelId ?? existing.sourceChannelId

      const scheduleChanged =
        body.startAtMs !== undefined
        || body.timeZone !== undefined
        || body.hasRecurrence === true
        || body.paused !== undefined

      let nextRunAtMs = existing.nextRunAtMs
      let occurrenceCount = existing.occurrenceCount
      if (scheduleChanged) {
        const recomputed = computeInitialNextRun(
          { startAtMs, timeZone, recurrence },
          paused,
          nowMs,
        )
        nextRunAtMs = recomputed.nextRunAtMs
        occurrenceCount = recomputed.occurrenceCount
        // Remove un-dispatched pending runs when schedule is paused or changed.
        this.ctx.storage.sql.exec(
          "DELETE FROM calendar_runs WHERE event_id = ? AND status = 'pending'",
          eventId,
        )
      }

      this.ctx.storage.sql.exec(
        `UPDATE calendar_events SET
          title = ?, description = ?, start_at_ms = ?, duration_minutes = ?,
          time_zone = ?, recurrence_json = ?, occurrence_count = ?, next_run_at_ms = ?,
          paused = ?, source_message_id = ?, source_channel_id = ?,
          version = version + 1, updated_at_ms = ?
        WHERE id = ?`,
        title,
        description,
        startAtMs,
        durationMinutes,
        timeZone,
        recurrence ? JSON.stringify(recurrence) : null,
        occurrenceCount,
        nextRunAtMs,
        paused ? 1 : 0,
        sourceMessageId,
        sourceChannelId,
        nowMs,
        eventId,
      )

      const updatedRow = this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM calendar_events WHERE id = ?",
        eventId,
      ).one()
      const latest = this.ctx.storage.sql.exec<RunRow>(
        "SELECT * FROM calendar_runs WHERE event_id = ? ORDER BY scheduled_at_ms DESC LIMIT 1",
        eventId,
      ).toArray()[0]
      const nextAlarmMs = this.queryEarliestNextRunMs()
      return {
        found: true as const,
        event: mapEventRow(updatedRow),
        latestRun: latest ? mapRunRow(latest) : null,
        nextAlarmMs,
      }
    })

    if (!outcome.found) return Response.json({ error: "event not found" }, { status: 404 })

    await this.applyAlarm(outcome.nextAlarmMs, nowMs)
    await this.notifyOwnerChanged(outcome.event.ownerUserId, outcome.event.id, "updated")
    return Response.json({ event: outcome.event, latestRun: outcome.latestRun })
  }

  private async handleDelete(eventId: string, request: Request): Promise<Response> {
    let ownerUserId: string | null = null
    try {
      const body = (await request.json()) as { ownerUserId?: string }
      if (typeof body.ownerUserId === "string") ownerUserId = body.ownerUserId
    } catch {
      // Optional body
    }

    const nowMs = Date.now()
    const outcome = this.ctx.storage.transactionSync(() => {
      const existingRow = this.ctx.storage.sql.exec<EventRow>(
        "SELECT * FROM calendar_events WHERE id = ?",
        eventId,
      ).toArray()[0]
      if (!existingRow) return { found: false as const }

      this.ctx.storage.sql.exec("DELETE FROM calendar_runs WHERE event_id = ?", eventId)
      this.ctx.storage.sql.exec("DELETE FROM calendar_events WHERE id = ?", eventId)
      const nextAlarmMs = this.queryEarliestNextRunMs()
      return { found: true as const, ownerUserId: existingRow.owner_user_id, nextAlarmMs }
    })

    if (!outcome.found) return Response.json({ error: "event not found" }, { status: 404 })

    await this.applyAlarm(outcome.nextAlarmMs, nowMs)
    await this.notifyOwnerChanged(ownerUserId ?? outcome.ownerUserId, eventId, "deleted")
    return Response.json({ deleted: true })
  }

  private async handleResyncBots(request: Request): Promise<Response> {
    let body: { ownerUserId?: string; botIds?: string[] }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    const ownerUserId = body.ownerUserId
    const botIds = Array.isArray(body.botIds)
      ? [...new Set(body.botIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : []
    if (!ownerUserId || botIds.length === 0) {
      return Response.json({ attempted: 0, dispatched: 0, blocked: 0 })
    }

    const placeholders = botIds.map(() => "?").join(", ")
    const pendingRows = this.ctx.storage.sql.exec<RunRow>(
      `SELECT * FROM calendar_runs WHERE status = 'pending' AND bot_user_id IN (${placeholders}) ORDER BY scheduled_at_ms ASC LIMIT ?`,
      ...botIds,
      RESYNC_RUN_BATCH_LIMIT,
    ).toArray()

    let attempted = 0
    let dispatched = 0
    let blocked = 0
    for (const row of pendingRows) {
      const run = mapRunRow(row)
      const result = await this.dispatchPendingRun(run, ownerUserId)
      if (result !== "skipped") attempted += 1
      if (result === "dispatched") dispatched += 1
      if (result === "blocked_access") blocked += 1
    }

    return Response.json({ attempted, dispatched, blocked })
  }
}
