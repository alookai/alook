import { BOT_PRIVATE_INBOX_RESYNC_MAX_PER_BOT } from "./bot-private-inbox"
import type { HostCommand } from "./community-cli-contract"
import type { Database } from "./db/index"
import { withD1Retry } from "./db/resilience"
import * as communityAgentInbox from "./db/queries/community/agent-inbox"
import * as communityBot from "./db/queries/community/bot"
import * as communityBotPrivateInbox from "./db/queries/community/bot-private-inbox"
import type { StoredBotPrivateInboxEvent } from "./db/queries/community/bot-private-inbox"
import * as communityChannel from "./db/queries/community/channel"
import * as communityDm from "./db/queries/community/dm"
import * as communityFriendship from "./db/queries/community/friendship"
import * as communityMessage from "./db/queries/community/message"
import * as communitySchedule from "./db/queries/community/schedule"
import { resolveModelConfig } from "./community/bot-model"
import { makeRuntimeConfig } from "./runtime-config"
import { buildScheduleEventPrompt } from "./schedule"
import { visibilityIsDmParticipant } from "./utils/community-roles"
import { formatHandle } from "./lib/discriminator"

export type PushAgentEventFn = (
  machineId: string,
  command: Extract<HostCommand, { type: "agent:event" }>,
) => Promise<{ sent: number }>

export type NotifyScheduleChangeFn = (
  ownerUserId: string,
  eventId: string,
  reason: "run_updated",
) => Promise<void>

export interface DispatchPrivateInboxResult {
  outcome: "dispatched" | "pending" | "blocked_access" | "failed" | "ignored"
  event: StoredBotPrivateInboxEvent
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
      () => communityDm.getDM(db, channelId),
      { route: "bot-private-inbox:dm-surface" },
    )
    if (!dm) return false
    const peer = await withD1Retry(
      () => communityDm.getDMPeer(db, channelId, botUserId),
      { route: "bot-private-inbox:dm-peer" },
    )
    if (!peer) return false
    const blocked = await withD1Retry(
      () => communityFriendship.isBlocked(db, botUserId, peer.otherUserId),
      { route: "bot-private-inbox:dm-block" },
    )
    return !blocked
  }
  const channel = await withD1Retry(
    () => communityChannel.getChannelForMember(db, channelId, botUserId),
    { route: "bot-private-inbox:channel-member" },
  )
  return channel !== null
}

export async function dispatchBotPrivateInboxEvent(
  db: Database,
  pushAgentEvent: PushAgentEventFn,
  event: StoredBotPrivateInboxEvent,
  opts: { notifyScheduleChange?: NotifyScheduleChangeFn } = {},
): Promise<DispatchPrivateInboxResult> {
  if (event.sourceKind === "schedule") {
    return dispatchSchedulePrivateInboxEvent(db, pushAgentEvent, event, opts.notifyScheduleChange)
  }

  const botCtx = await withD1Retry(
    () => communityBot.getBotWakeContext(db, event.botUserId),
    { route: "bot-private-inbox:bot-wake-context" },
  )

  if (botCtx.state !== "ready") {
    const status = botCtx.state === "bot_unbound" ? "pending" : "failed"
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status,
            lastError: botCtx.state,
          }),
        { route: "bot-private-inbox:update-unavailable" },
      )) ?? { ...event, status, lastError: botCtx.state }
    return { outcome: status, event: updated }
  }

  if (botCtx.ownerUserId !== event.ownerUserId) {
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "failed",
            lastError: "owner_mismatch",
          }),
        { route: "bot-private-inbox:update-owner-mismatch" },
      )) ?? { ...event, status: "failed", lastError: "owner_mismatch" }
    return { outcome: "failed", event: updated }
  }

  const push = await pushAgentEvent(botCtx.machineId, {
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
    launchId: event.id,
    prompt: event.promptText,
  })

  if (push.sent > 0) {
    const nowMs = Date.now()
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "dispatched",
            lastError: null,
            dispatchedAtMs: nowMs,
          }),
        { route: "bot-private-inbox:update-dispatched" },
      )) ?? { ...event, status: "dispatched", lastError: null, dispatchedAtMs: nowMs }
    return { outcome: "dispatched", event: updated }
  }

  const updated =
    (await withD1Retry(
      () =>
        communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
          status: "pending",
          lastError: "machine_offline",
        }),
      { route: "bot-private-inbox:update-offline" },
    )) ?? { ...event, status: "pending", lastError: "machine_offline" }
  return { outcome: "pending", event: updated }
}

async function dispatchSchedulePrivateInboxEvent(
  db: Database,
  pushAgentEvent: PushAgentEventFn,
  event: StoredBotPrivateInboxEvent,
  notifyScheduleChange?: NotifyScheduleChangeFn,
): Promise<DispatchPrivateInboxResult> {
  const runId = event.sourceRefId
  if (!runId) {
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "ignored",
            lastError: "schedule_run_missing",
          }),
        { route: "bot-private-inbox:schedule-run-missing" },
      )) ?? { ...event, status: "ignored", lastError: "schedule_run_missing" }
    return { outcome: "ignored", event: updated }
  }

  const current = await withD1Retry(
    () => communitySchedule.getScheduleRunById(db, runId),
    { route: "bot-private-inbox:schedule-get-run" },
  )
  if (!current || current.status !== "pending") {
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "ignored",
            lastError: "schedule_run_not_pending",
          }),
        { route: "bot-private-inbox:schedule-run-not-pending" },
      )) ?? { ...event, status: "ignored", lastError: "schedule_run_not_pending" }
    return { outcome: "ignored", event: updated }
  }

  const nowMs = Date.now()
  const markBlocked = async (reason: string): Promise<DispatchPrivateInboxResult> => {
    await withD1Retry(
      () =>
        communitySchedule.updatePendingRunStatus(db, runId, {
          status: "blocked_access",
          lastError: reason,
          updatedAtMs: nowMs,
        }),
      { route: "bot-private-inbox:schedule-mark-blocked" },
    )
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "failed",
            lastError: reason,
          }),
        { route: "bot-private-inbox:schedule-inbox-blocked" },
      )) ?? { ...event, status: "failed", lastError: reason }
    await notifyScheduleChange?.(current.ownerUserId, current.eventId, "run_updated")
    return { outcome: "blocked_access", event: updated }
  }

  const markPendingError = async (reason: string): Promise<DispatchPrivateInboxResult> => {
    await withD1Retry(
      () =>
        communitySchedule.updatePendingRunStatus(db, runId, {
          status: "pending",
          lastError: reason,
          updatedAtMs: nowMs,
        }),
      { route: "bot-private-inbox:schedule-mark-pending" },
    )
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "pending",
            lastError: reason,
          }),
        { route: "bot-private-inbox:schedule-inbox-pending" },
      )) ?? { ...event, status: "pending", lastError: reason }
    await notifyScheduleChange?.(current.ownerUserId, current.eventId, "run_updated")
    return { outcome: "pending", event: updated }
  }

  const botCtx = await withD1Retry(
    () => communityBot.getBotWakeContext(db, current.botUserId),
    { route: "bot-private-inbox:schedule-bot-wake-context" },
  )
  if (botCtx.state !== "ready") {
    if (botCtx.state === "bot_unbound") return markPendingError("bot_unbound")
    return markBlocked(botCtx.state)
  }
  if (botCtx.ownerUserId !== current.ownerUserId) {
    return markBlocked("owner_mismatch")
  }

  const msg = await withD1Retry(
    () => communityMessage.getWakeMessageScopeById(db, current.sourceMessageId),
    { route: "bot-private-inbox:schedule-source-message" },
  )
  if (!msg) return markBlocked("source_message_deleted")

  const channelType = await withD1Retry(
    () => communityChannel.getChannelType(db, msg.channelId),
    { route: "bot-private-inbox:schedule-source-channel-type" },
  )
  const canRead = await canBotAccessMessageSurface(db, msg.channelId, current.botUserId, channelType)
  if (!canRead) return markBlocked("source_message_inaccessible")

  const channelRef = await withD1Retry(
    () =>
      communityAgentInbox.resolveUnreadNoticeChannel(
        db,
        { channelId: msg.channelId },
        current.botUserId,
      ),
    { route: "bot-private-inbox:schedule-source-channel-ref" },
  )
  if (!channelRef) return markBlocked("source_channel_unresolvable")

  const prompt = buildScheduleEventPrompt({
    eventId: current.eventId,
    title: current.titleSnapshot,
    description: current.descriptionSnapshot,
    scheduledAtMs: current.scheduledAtMs,
    channelRef,
    seq: msg.seq,
    channelType,
  })

  const push = await pushAgentEvent(botCtx.machineId, {
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
    launchId: `schrun_${current.id}`,
    prompt,
  })

  if (push.sent > 0) {
    const dispatchedAtMs = Date.now()
    await withD1Retry(
      () =>
        communitySchedule.updatePendingRunStatus(db, runId, {
          status: "dispatched",
          lastError: null,
          updatedAtMs: dispatchedAtMs,
        }),
      { route: "bot-private-inbox:schedule-mark-dispatched" },
    )
    const updated =
      (await withD1Retry(
        () =>
          communityBotPrivateInbox.updatePrivateInboxEventStatus(db, event.id, {
            status: "dispatched",
            lastError: null,
            dispatchedAtMs,
            summary: current.titleSnapshot,
            promptText: prompt,
          }),
        { route: "bot-private-inbox:schedule-inbox-dispatched" },
      )) ?? {
        ...event,
        status: "dispatched",
        lastError: null,
        dispatchedAtMs,
        summary: current.titleSnapshot,
        promptText: prompt,
      }
    await notifyScheduleChange?.(current.ownerUserId, current.eventId, "run_updated")
    return { outcome: "dispatched", event: updated }
  }

  return markPendingError("machine_offline")
}

export async function resyncBotPrivateInboxForBots(
  db: Database,
  pushAgentEvent: PushAgentEventFn,
  ownerUserId: string,
  botIds: readonly string[],
  opts: {
    notifyScheduleChange?: NotifyScheduleChangeFn
    limitPerBot?: number
  } = {},
): Promise<{ attempted: number; dispatched: number; blocked: number }> {
  if (botIds.length === 0) return { attempted: 0, dispatched: 0, blocked: 0 }
  const limit = opts.limitPerBot ?? BOT_PRIVATE_INBOX_RESYNC_MAX_PER_BOT
  let attempted = 0
  let dispatched = 0
  let blocked = 0
  for (const botId of botIds) {
    const pendingRuns = await withD1Retry(
      () => communitySchedule.listPendingRunsForBot(db, ownerUserId, botId, limit),
      { route: "bot-private-inbox:list-pending-schedule-runs" },
    )
    for (const run of pendingRuns) {
      await withD1Retry(
        () =>
          communityBotPrivateInbox.enqueuePrivateInboxEvent(db, {
            ownerUserId: run.ownerUserId,
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
        { route: "bot-private-inbox:backfill-schedule-run" },
      )
    }
    const pending = await withD1Retry(
      () => communityBotPrivateInbox.listPendingPrivateInboxEventsForBot(db, botId, limit),
      { route: "bot-private-inbox:list-pending-resync" },
    )
    for (const item of pending) {
      if (item.ownerUserId !== ownerUserId) continue
      const result = await dispatchBotPrivateInboxEvent(db, pushAgentEvent, item, opts)
      if (result.outcome !== "ignored") attempted += 1
      if (result.outcome === "dispatched") dispatched += 1
      if (result.outcome === "blocked_access") blocked += 1
    }
  }
  return { attempted, dispatched, blocked }
}
