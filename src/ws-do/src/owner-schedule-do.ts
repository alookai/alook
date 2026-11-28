import { DurableObject } from "cloudflare:workers"
import {
  createDb,
  createLogger,
  dispatchBotPrivateInboxEvent,
  queries,
  resyncBotPrivateInboxForBots,
  withD1Retry,
  WS_EVENTS,
  type BotAuditWakeBroadcastEvent,
  type HostCommand,
  type StoredScheduleRun,
} from "@alook/shared"
import { createInternalBrowserBroadcastRequest } from "./internal-user-broadcast"

const log = createLogger({ service: "owner-schedule-do" })

const OWNER_USER_ID_KEY = "ownerUserId"
const ALARM_EVENT_BATCH_LIMIT = 25
const RESYNC_RUN_BATCH_LIMIT = 50

type ScheduleChangeReason = "created" | "updated" | "deleted" | "run_updated"

export class OwnerScheduleDurableObject extends DurableObject<Env> {
  private readonly inFlightRuns = new Set<string>()

  private async syncAlarmFromD1(ownerUserId: string, nowMs: number): Promise<number | null> {
    const db = createDb(this.env.DB)
    const nextAlarmMs = await withD1Retry(
      () => queries.communitySchedule.getEarliestNextRunMs(db, ownerUserId),
      { route: "owner-schedule:earliest-next-run" },
    )
    if (nextAlarmMs !== null) {
      await this.ctx.storage.put(OWNER_USER_ID_KEY, ownerUserId)
      await this.ctx.storage.setAlarm(Math.max(nextAlarmMs, nowMs))
      return nextAlarmMs
    }
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
    return null
  }

  private async notifyOwnerChanged(
    ownerUserId: string,
    eventId: string,
    reason: ScheduleChangeReason,
  ): Promise<void> {
    try {
      const doId = this.env.WS_DO.idFromName("user:" + ownerUserId)
      const stub = this.env.WS_DO.get(doId)
      await stub.fetch(
        createInternalBrowserBroadcastRequest(ownerUserId, {
          type: WS_EVENTS.SCHEDULE_CHANGED,
          eventId,
          reason,
        }),
      )
    } catch (err) {
      log.warn("schedule_owner_broadcast_failed", { ownerUserId, eventId, reason, err: String(err) })
    }
  }

  private async broadcastBotAuditEvent(event: BotAuditWakeBroadcastEvent): Promise<void> {
    try {
      const doId = this.env.WS_DO.idFromName("user:" + event.ownerUserId)
      const stub = this.env.WS_DO.get(doId)
      await stub.fetch(
        createInternalBrowserBroadcastRequest(event.ownerUserId, {
          type: WS_EVENTS.BOT_AUDIT_EVENT,
          botId: event.botId,
          id: event.id,
          kind: event.kind,
          payload: event.payload,
          sessionId: null,
          launchId: event.launchId,
          createdAt: event.createdAt,
        }),
      )
    } catch (err) {
      log.warn("private_inbox_audit_broadcast_failed", {
        ownerUserId: event.ownerUserId,
        botId: event.botId,
        err: String(err),
      })
    }
  }

  private async pushAgentEventToMachine(
    machineId: string,
    command: Extract<HostCommand, { type: "agent:event" }>,
  ): Promise<{ sent: number }> {
    const db = createDb(this.env.DB)
    const doNames = await withD1Retry(
      () => queries.communityMachine.getActiveDoNamesForMachine(db, machineId),
      { route: "owner-schedule:machine-do-names" },
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
        log.warn("schedule_machine_push_failed", { machineId, doName, err: String(err) })
      }
    }
    return { sent }
  }

  private async dispatchPendingRun(
    run: StoredScheduleRun,
    ownerUserId: string,
  ): Promise<"dispatched" | "pending" | "blocked_access" | "skipped"> {
    if (this.inFlightRuns.has(run.id)) return "skipped"
    this.inFlightRuns.add(run.id)
    try {
      const db = createDb(this.env.DB)
      const { event } = await withD1Retry(
        () =>
          queries.communityBotPrivateInbox.enqueuePrivateInboxEvent(db, {
            ownerUserId,
            botUserId: run.botUserId,
            sourceKind: "schedule",
            sourceId: run.eventId,
            sourceRefId: run.id,
            dedupeKey: String(run.scheduledAtMs),
            eventType: "schedule.triggered",
            summary: run.titleSnapshot,
            promptText: "",
            status: "pending",
            nowMs: run.createdAtMs,
          }),
        { route: "owner-schedule:enqueue-private-inbox" },
      )
      if (event.status !== "pending") return "skipped"

      const result = await dispatchBotPrivateInboxEvent(
        db,
        (machineId, command) => this.pushAgentEventToMachine(machineId, command),
        event,
        {
          notifyScheduleChange: (ownerId, eventId, reason) =>
            this.notifyOwnerChanged(ownerId, eventId, reason),
          broadcastBotAuditEvent: (auditEvent) => this.broadcastBotAuditEvent(auditEvent),
        },
      )
      if (result.outcome === "dispatched") return "dispatched"
      if (result.outcome === "blocked_access") return "blocked_access"
      if (result.outcome === "pending") return "pending"
      return "skipped"
    } catch (err) {
      log.warn("schedule_run_dispatch_failed", { runId: run.id, eventId: run.eventId, err: String(err) })
      return "pending"
    } finally {
      this.inFlightRuns.delete(run.id)
    }
  }

  async alarm(): Promise<void> {
    const ownerUserId = await this.ctx.storage.get<string>(OWNER_USER_ID_KEY)
    if (!ownerUserId) {
      await this.ctx.storage.deleteAll()
      return
    }

    const db = createDb(this.env.DB)
    const nowMs = Date.now()
    const dueEvents = await withD1Retry(
      () => queries.communitySchedule.listDueEventsForOwner(db, ownerUserId, nowMs, ALARM_EVENT_BATCH_LIMIT),
      { route: "owner-schedule:list-due" },
    )

    const runsToDispatch: StoredScheduleRun[] = []
    for (const event of dueEvents) {
      const claimed = await withD1Retry(
        () => queries.communitySchedule.claimDueEventOccurrence(db, event, nowMs),
        { route: "owner-schedule:claim-due" },
      )
      if (claimed && claimed.status === "pending") {
        runsToDispatch.push(claimed)
      }
    }

    await this.syncAlarmFromD1(ownerUserId, nowMs)

    for (const run of runsToDispatch) {
      await this.dispatchPendingRun(run, ownerUserId)
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/sync-alarm" && request.method === "POST") {
      return this.handleSyncAlarm(request)
    }
    if (url.pathname === "/resync-bots" && request.method === "POST") {
      return this.handleResyncBots(request)
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }

  private async handleSyncAlarm(request: Request): Promise<Response> {
    let body: {
      ownerUserId?: string
      eventId?: string
      reason?: ScheduleChangeReason
    }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return Response.json({ error: "invalid json" }, { status: 400 })
    }
    if (!body.ownerUserId) {
      return Response.json({ error: "missing ownerUserId" }, { status: 400 })
    }

    const nextAlarmMs = await this.syncAlarmFromD1(body.ownerUserId, Date.now())
    if (body.eventId && body.reason) {
      await this.notifyOwnerChanged(body.ownerUserId, body.eventId, body.reason)
    }
    return Response.json({ nextAlarmMs })
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
      ? body.botIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : []
    if (!ownerUserId || botIds.length === 0) {
      return Response.json({ attempted: 0, dispatched: 0, blocked: 0 })
    }

    const db = createDb(this.env.DB)
    await this.syncAlarmFromD1(ownerUserId, Date.now())
    const result = await resyncBotPrivateInboxForBots(
      db,
      (machineId, command) => this.pushAgentEventToMachine(machineId, command),
      ownerUserId,
      botIds,
      {
        limitPerBot: RESYNC_RUN_BATCH_LIMIT,
        notifyScheduleChange: (ownerId, eventId, reason) =>
          this.notifyOwnerChanged(ownerId, eventId, reason),
        broadcastBotAuditEvent: (auditEvent) => this.broadcastBotAuditEvent(auditEvent),
      },
    )

    return Response.json(result)
  }
}
