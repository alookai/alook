import { DurableObject } from "cloudflare:workers"
import {
  createDb,
  createLogger,
  formatHandle,
  makeRuntimeConfig,
  queries,
  resolveModelConfig,
  visibilityIsDmParticipant,
  withD1Retry,
  WS_EVENTS,
  type Database,
  type HostCommand,
  type StoredCalendarRun,
} from "@alook/shared"
import { createInternalBrowserBroadcastRequest } from "./internal-user-broadcast"

const log = createLogger({ service: "owner-calendar-do" })

const OWNER_USER_ID_KEY = "ownerUserId"
const ALARM_EVENT_BATCH_LIMIT = 25
const RESYNC_RUN_BATCH_LIMIT = 50

type CalendarChangeReason = "created" | "updated" | "deleted" | "run_updated"

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
    "Execute this scheduled task now. Do not merely check whether the schedule exists.",
    `Inspect context if needed: ${historyCommand}`,
    `Reply to the bound conversation with: ${replyCommand}`,
    `After finishing this scheduled task, mark it done with: $ALOOK_CLI calendar update ${input.eventId} --ack`,
  )
  return lines.join("\n")
}

async function canBotAccessMessageSurface(
  db: Database,
  channelId: string,
  botUserId: string,
  channelType: string | null,
): Promise<boolean> {
  if (!channelType) return false
  if (visibilityIsDmParticipant(channelType)) {
    const dm = await withD1Retry(
      () => queries.communityDm.getDM(db, channelId),
      { route: "owner-calendar:dm-surface" },
    )
    if (!dm) return false
    const peer = await withD1Retry(
      () => queries.communityDm.getDMPeer(db, channelId, botUserId),
      { route: "owner-calendar:dm-peer" },
    )
    if (!peer) return false
    const blocked = await withD1Retry(
      () => queries.communityFriendship.isBlocked(db, botUserId, peer.otherUserId),
      { route: "owner-calendar:dm-block" },
    )
    return !blocked
  }
  const channel = await withD1Retry(
    () => queries.communityChannel.getChannelForMember(db, channelId, botUserId),
    { route: "owner-calendar:channel-member" },
  )
  return channel !== null
}

/**
 * Stateless per-owner alarm timer and dispatch coordinator.
 * All calendar events and runs are persisted in D1; this DO holds only
 * the ownerUserId key while an alarm is active and wipes itself via
 * `deleteAll()` once no future occurrences remain.
 */
export class OwnerCalendarDurableObject extends DurableObject<Env> {
  private readonly inFlightRuns = new Set<string>()

  private async syncAlarmFromD1(ownerUserId: string, nowMs: number): Promise<number | null> {
    const db = createDb(this.env.DB)
    const nextAlarmMs = await withD1Retry(
      () => queries.communityCalendar.getEarliestNextRunMs(db, ownerUserId),
      { route: "owner-calendar:earliest-next-run" },
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
    reason: CalendarChangeReason,
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
      const db = createDb(this.env.DB)
      const current = await withD1Retry(
        () => queries.communityCalendar.getCalendarRunById(db, run.id),
        { route: "owner-calendar:get-run" },
      )
      if (!current || current.status !== "pending") return "skipped"

      const nowMs = Date.now()

      const markBlocked = async (reason: string): Promise<"blocked_access"> => {
        await withD1Retry(
          () => queries.communityCalendar.updatePendingRunStatus(db, run.id, {
            status: "blocked_access",
            lastError: reason,
            updatedAtMs: nowMs,
          }),
          { route: "owner-calendar:mark-blocked" },
        )
        await this.notifyOwnerChanged(ownerUserId, run.eventId, "run_updated")
        return "blocked_access"
      }

      const markPendingError = async (reason: string): Promise<"pending"> => {
        await withD1Retry(
          () => queries.communityCalendar.updatePendingRunStatus(db, run.id, {
            status: "pending",
            lastError: reason,
            updatedAtMs: nowMs,
          }),
          { route: "owner-calendar:mark-pending-error" },
        )
        await this.notifyOwnerChanged(ownerUserId, run.eventId, "run_updated")
        return "pending"
      }

      const botCtx = await withD1Retry(
        () => queries.communityBot.getBotWakeContext(db, current.botUserId),
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
        () => queries.communityMessage.getWakeMessageScopeById(db, current.sourceMessageId),
        { route: "owner-calendar:source-message" },
      )
      if (!msg) return await markBlocked("source_message_deleted")

      const channelType = await withD1Retry(
        () => queries.communityChannel.getChannelType(db, msg.channelId),
        { route: "owner-calendar:source-channel-type" },
      )
      const canRead = await canBotAccessMessageSurface(db, msg.channelId, current.botUserId, channelType)
      if (!canRead) return await markBlocked("source_message_inaccessible")

      const channelRef = await withD1Retry(
        () => queries.communityAgentInbox.resolveUnreadNoticeChannel(db, { channelId: msg.channelId }, current.botUserId),
        { route: "owner-calendar:source-channel-ref" },
      )
      if (!channelRef) return await markBlocked("source_channel_unresolvable")

      const prompt = buildCalendarEventPrompt({
        eventId: current.eventId,
        title: current.titleSnapshot,
        description: current.descriptionSnapshot,
        scheduledAtMs: current.scheduledAtMs,
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
        launchId: `calrun_${current.id}`,
        prompt,
      }

      const { sent } = await this.pushAgentEventToMachine(botCtx.machineId, command)
      if (sent > 0) {
        await withD1Retry(
          () => queries.communityCalendar.updatePendingRunStatus(db, run.id, {
            status: "dispatched",
            lastError: null,
            updatedAtMs: Date.now(),
          }),
          { route: "owner-calendar:mark-dispatched" },
        )
        await this.notifyOwnerChanged(ownerUserId, current.eventId, "run_updated")
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
    const ownerUserId = await this.ctx.storage.get<string>(OWNER_USER_ID_KEY)
    if (!ownerUserId) {
      await this.ctx.storage.deleteAll()
      return
    }

    const db = createDb(this.env.DB)
    const nowMs = Date.now()
    const dueEvents = await withD1Retry(
      () => queries.communityCalendar.listDueEventsForOwner(db, ownerUserId, nowMs, ALARM_EVENT_BATCH_LIMIT),
      { route: "owner-calendar:list-due" },
    )

    const runsToDispatch: StoredCalendarRun[] = []
    for (const event of dueEvents) {
      const claimed = await withD1Retry(
        () => queries.communityCalendar.claimDueEventOccurrence(db, event, nowMs),
        { route: "owner-calendar:claim-due" },
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
      reason?: CalendarChangeReason
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
    const botIdSet = new Set(
      Array.isArray(body.botIds)
        ? body.botIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [],
    )
    if (!ownerUserId || botIdSet.size === 0) {
      return Response.json({ attempted: 0, dispatched: 0, blocked: 0 })
    }

    const db = createDb(this.env.DB)
    await this.syncAlarmFromD1(ownerUserId, Date.now())
    const pendingRuns = await withD1Retry(
      () => queries.communityCalendar.listPendingRunsForOwner(db, ownerUserId, RESYNC_RUN_BATCH_LIMIT),
      { route: "owner-calendar:list-pending-resync" },
    )

    let attempted = 0
    let dispatched = 0
    let blocked = 0
    for (const run of pendingRuns) {
      if (!botIdSet.has(run.botUserId)) continue
      const result = await this.dispatchPendingRun(run, ownerUserId)
      if (result !== "skipped") attempted += 1
      if (result === "dispatched") dispatched += 1
      if (result === "blocked_access") blocked += 1
    }

    return Response.json({ attempted, dispatched, blocked })
  }
}
