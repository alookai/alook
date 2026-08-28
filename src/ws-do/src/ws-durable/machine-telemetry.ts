import {
  AgentActivityMessageSchema,
  DailyUsageSnapshotSchema,
  AgentTypingMessageSchema,
  AgentTypingStopMessageSchema,
  createDb,
  HostBotAuditEventFrameSchema,
  isBotActivityStatus,
  pickBotActivityPreset,
  ProviderQuotaSnapshotSchema,
  queries,
  RUNNING_PRESETS,
  withD1Retry,
  WS_EVENTS,
  utcDayKeyDaysAgo,
} from "@alook/shared"
import { handleFrameForBoundBot } from "./bound-bot-frame"
import type { CommunityMachineIdentity, WsDurableContext } from "./internal"
import {
  broadcastToAudience,
  fanOutTyping,
  fanOutTypingStop,
  notifyUserDO,
} from "./presence-typing"
import {
  prepareActivityProfileUpsert,
  prepareQuotaReplace,
  prepareUsagePrune,
  prepareUsageUpsert,
} from "./provider-telemetry-persistence"

const IDLE_RESET_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * Telemetry handlers are deliberately independent first-match branches. Each
 * returns false only when its schema does not recognize the frame; once a
 * schema matches, binding mismatches and write failures consume the frame.
 * This keeps later schemas from observing a frame already owned by an earlier
 * protocol branch and preserves the original monolith's drop behavior.
 */

/**
 * Daemon activity is translated into the same status fields humans use, so
 * downstream consumers never branch on whether the user is a bot. Running
 * chooses one persisted preset per episode; repeated running frames reuse it.
 * The reporting machine must own the bot before any profile write occurs.
 * Empty status pairs remain writable, while a non-preset pair is treated as
 * a custom owner status. The resulting update uses the common presence
 * audience rather than a bot-specific delivery path.
 */
export async function handleActivityFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const activityParse = AgentActivityMessageSchema
    .omit({ dailyUsage: true, quota: true })
    .passthrough()
    .safeParse(parsed)
  if (!activityParse.success) return false

  const { agentId, state } = activityParse.data
  const raw = parsed as Record<string, unknown>
  const now = new Date()
  const allowedDays = new Set(Array.from({ length: 7 }, (_, offset) => utcDayKeyDaysAgo(now, offset)))
  const usageParse = raw.dailyUsage === undefined
    ? null
    : DailyUsageSnapshotSchema.array().max(7).safeParse(raw.dailyUsage)
  const parsedUsage = usageParse?.success ? usageParse.data : undefined
  const usageDays = parsedUsage ? new Set(parsedUsage.map((snapshot) => snapshot.day)) : null
  const validUsage = state === "idle"
    && parsedUsage !== undefined
    && usageDays?.size === parsedUsage.length
    && parsedUsage.every((snapshot) => snapshot.botId === agentId && allowedDays.has(snapshot.day))
      ? parsedUsage
      : undefined
  const quotaParse = raw.quota === undefined
    ? null
    : ProviderQuotaSnapshotSchema.safeParse(raw.quota)
  const validQuota = quotaParse?.success ? quotaParse.data : undefined
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "agent_activity",
    agentId,
    machineId: identity.machineId,
    resolveBinding: () => queries.communityBot.getBotBinding(db, agentId),
    isMatch: (binding) => binding.machineId === identity.machineId,
    write: async (binding) => {
      const prior = await withD1Retry(
        () => queries.communityUserProfile.getProfile(db, agentId),
        { route: "ws-do:agent-activity-profile-read" },
      )
      const priorEmoji = prior?.statusEmoji ?? null
      // `status_text` defaults to "". Normalize it to null so an unset status
      // is writable and does not look like an owner-authored custom status.
      const priorText = prior?.statusText ? prior.statusText : null
      // This path owns only known activity pills. Any other persisted pair is
      // owner-authored and must survive activity heartbeats unchanged.
      const customStatus =
        (priorEmoji !== null || priorText !== null) &&
        !isBotActivityStatus(priorEmoji, priorText)
      const profileWritable = !customStatus
      const priorIsRunning =
        priorEmoji !== null &&
        RUNNING_PRESETS.some((preset) => preset.emoji === priorEmoji && preset.text === priorText)
      // Reuse an existing running preset instead of rerolling on every
      // derived turn_end → idle → wake → running transition.
      const preset = profileWritable
        ? (
        state === "running" && priorIsRunning
          ? { emoji: priorEmoji as string, text: priorText as string }
          : pickBotActivityPreset(state, Math.random())
        )
        : null
      const profileChanged = preset !== null
        && (preset.emoji !== priorEmoji || preset.text !== priorText)
      const quota = validQuota?.agentBackendId === binding.runtime ? validQuota : undefined
      const hasTelemetry = (validUsage?.length ?? 0) > 0 || quota !== undefined
      if (!hasTelemetry) {
        if (!profileChanged || !preset) return
        await withD1Retry(
          () => queries.communityUserProfile.updateProfile(db, agentId, {
            statusEmoji: preset.emoji,
            statusText: preset.text,
          }),
          { route: "ws-do:agent-activity-profile" },
        )
        await broadcastToAudience(context, agentId, {
          type: WS_EVENTS.STATUS_UPDATE,
          userId: agentId,
          statusEmoji: preset.emoji,
          statusText: preset.text,
        })
        return
      }
      const nowIso = now.toISOString()
      const statements: D1PreparedStatement[] = []
      const profileStatementIndex = profileChanged && preset ? statements.length : -1
      if (profileChanged && preset) {
        statements.push(prepareActivityProfileUpsert(
          context.env.DB,
          identity.machineId,
          agentId,
          preset.emoji,
          preset.text,
        ))
      }
      for (const snapshot of validUsage ?? []) {
        statements.push(prepareUsageUpsert(context.env.DB, identity.machineId, snapshot, nowIso))
      }
      if (validUsage && validUsage.length > 0) {
        statements.push(prepareUsagePrune(
          context.env.DB,
          identity.machineId,
          agentId,
          utcDayKeyDaysAgo(now, 6),
        ))
      }
      if (quota) statements.push(prepareQuotaReplace(context.env.DB, identity, quota, nowIso))
      const results = await context.env.DB.batch(statements)
      if (
        profileStatementIndex >= 0
        && preset
        && (results[profileStatementIndex]?.meta.changes ?? 0) > 0
      ) {
        await broadcastToAudience(context, agentId, {
          type: WS_EVENTS.STATUS_UPDATE,
          userId: agentId,
          statusEmoji: preset.emoji,
          statusText: preset.text,
        })
      }
    },
  })
  return true
}

/**
 * Daemon typing bypasses the client-inbound eight-second dedup gate. The
 * daemon already meters its heartbeat and the client owns stale-indicator
 * expiry; applying both gates here would make the typing pill flicker.
 * Channel membership and reach are resolved inside the shared typing fan-out,
 * keeping DM pairs, thread participants, and server/roster audiences aligned
 * with human typing frames.
 */
export async function handleTypingFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const typingParse = AgentTypingMessageSchema.safeParse(parsed)
  if (!typingParse.success) return false

  const { agentId, channelId } = typingParse.data
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "agent_typing",
    agentId,
    machineId: identity.machineId,
    resolveBinding: () => withD1Retry(
      () => queries.communityBot.getBotBindingWithOwner(db, agentId),
      { route: "ws-do:agent-typing-binding" },
    ),
    isMatch: (binding) => binding.machineId === identity.machineId,
    write: async (binding) => {
      // Membership is enforced by `fanOutTyping`; the binding already carries
      // the bot display identity, avoiding another roster query per heartbeat.
      const event = {
        type: WS_EVENTS.TYPING_START,
        channelId,
        userId: agentId,
        name: binding.name,
        discriminator: binding.discriminator,
      }
      await fanOutTyping(context, agentId, channelId, event)
    },
  })
  return true
}

/**
 * A stop frame uses the same binding check and reach resolver as a start but
 * never traverses typing dedup. Stops must always land or the pill remains
 * until client-side expiry.
 */
export async function handleTypingStopFrame(
  context: WsDurableContext,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const typingStopParse = AgentTypingStopMessageSchema.safeParse(parsed)
  if (!typingStopParse.success) return false

  const { agentId, channelId } = typingStopParse.data
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "agent_typing_stop",
    agentId,
    machineId: identity.machineId,
    resolveBinding: () => withD1Retry(
      () => queries.communityBot.getBotBindingWithOwner(db, agentId),
      { route: "ws-do:agent-typing-stop-binding" },
    ),
    isMatch: (binding) => binding.machineId === identity.machineId,
    write: () => fanOutTypingStop(context, agentId, channelId),
  })
  return true
}

/**
 * Audit payload serialization happens before the shared bound-bot scaffold.
 * Serialization failures are not persistence loss and remain outside the
 * `ws_frame_dropped_write` SLO; binding failures do too. Only the insert path
 * uses the audit-write category, and successful rows notify the owner alone.
 * Insert, rolling prune, and the guarded Awake stamp stay atomic in the query
 * layer. Ordinary telemetry uses server time; idle reset uses its authenticated,
 * validated durable barrier time so delayed replay preserves product meaning.
 * A null insert produces no notification but still receives an idempotent ack.
 * This path must never use the general presence audience because per-bot
 * activity is private to the owner.
 * The stored payload remains a JSON string for the audit query while the
 * outbound payload retains the parsed object shape. sessionId and launchId
 * preserve null-vs-omitted normalization from the strict frame schema.
 */
export async function handleAuditFrame(
  context: WsDurableContext,
  ws: WebSocket,
  parsed: unknown,
  identity: CommunityMachineIdentity,
): Promise<boolean> {
  const auditParse = HostBotAuditEventFrameSchema.safeParse(parsed)
  if (!auditParse.success) return false

  const frame = auditParse.data
  const isIdleReset =
    frame.event.kind === "session_reset" &&
    frame.event.payload.trigger === "idle_timeout"
  if (
    isIdleReset
    && Date.parse(frame.occurredAt!) > Date.now() + IDLE_RESET_MAX_FUTURE_SKEW_MS
  ) {
    context.log.warn("ws_frame_dropped", {
      category: "ws_frame_dropped",
      frame_type: "bot_audit_event",
      phase: "future_occurred_at",
      agentId: frame.agentId,
      machineId: identity.machineId,
    })
    return true
  }
  let payload: string
  try {
    payload = JSON.stringify(frame.event.payload)
  } catch (err) {
    context.log.warn("ws_frame_dropped", {
      category: "ws_frame_dropped",
      frame_type: "bot_audit_event",
      phase: "serialize",
      agentId: frame.agentId,
      machineId: identity.machineId,
      err: err instanceof Error ? err : new Error(String(err)),
    })
    return true
  }
  const db = createDb(context.env.DB)
  await handleFrameForBoundBot(context, {
    frameType: "bot_audit_event",
    agentId: frame.agentId,
    machineId: identity.machineId,
    writeCategory: "ws_frame_dropped_write",
    resolveBinding: () => withD1Retry(
      () => queries.communityBot.getBotBindingWithOwner(db, frame.agentId),
      { route: "ws-do:bot-audit-binding" },
    ),
    isMatch: (binding) => binding.machineId === identity.machineId,
    write: async (binding) => {
      const createdAt = isIdleReset
        ? new Date(Date.parse(frame.occurredAt!)).toISOString()
        : new Date().toISOString()
      const extraStatements = isIdleReset
        ? [queries.communityBot.touchBotRefreshContextForAuditEventStatement(
          db,
          frame.agentId,
          frame.eventId!,
          createdAt,
        )]
        : []
      const inserted = await queries.communityBotAuditLog.insertBotActivityEventAndPrune(
        db,
        {
          ...(frame.eventId ? { id: frame.eventId } : {}),
          botId: frame.agentId,
          sessionId: frame.sessionId ?? null,
          launchId: frame.launchId ?? null,
          kind: frame.event.kind,
          payload,
          ...(isIdleReset ? { createdAt } : {}),
        },
        extraStatements,
      )
      if (inserted) {
        await notifyUserDO(context, binding.ownerUserId, {
          type: WS_EVENTS.BOT_AUDIT_EVENT,
          botId: frame.agentId,
          id: inserted.id,
          kind: frame.event.kind,
          payload: frame.event.payload,
          sessionId: frame.sessionId ?? null,
          launchId: frame.launchId ?? null,
          createdAt: inserted.createdAt,
        }).catch(() => { })
      }
      if (frame.eventId) {
        ws.send(JSON.stringify({ type: "bot_audit_event_ack", eventId: frame.eventId }))
      }
    },
  })
  return true
}
