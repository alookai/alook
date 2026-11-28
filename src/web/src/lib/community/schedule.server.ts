import {
  expandScheduleOccurrences,
  formatHandle,
  isValidIanaTimeZone,
  normalizeRecurrence,
  parseRef,
  queries,
  SCHEDULE_DEFAULT_DURATION_MINUTES,
  SCHEDULE_MAX_RANGE_MS,
  withD1Retry,
  type Database,
  type ScheduleActorSummary,
  type ScheduleEvent,
  type ScheduleLastExecution,
  type ScheduleOccurrence,
  type ScheduleRecurrence,
  type ScheduleRunStatus,
  type ScheduleSourceMessage,
  type StoredScheduleEvent,
  type StoredScheduleRun,
} from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import type { CommunityActor } from "@/lib/middleware/community-actor"

export function scheduleOwnerUserId(actor: CommunityActor): string {
  return actor.kind === "human" ? actor.userId : actor.ownerUserId
}

function ownerScheduleFetch(
  env: Env,
  ownerUserId: string,
  innerPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const path = `/owner-schedule/${encodeURIComponent(ownerUserId)}${innerPath}`
  return wsDoFetch(env, path, init, { label: ownerUserId, type: "owner-schedule" })
}

export async function syncOwnerScheduleAlarm(
  env: Env,
  ownerUserId: string,
  change?: {
    eventId: string
    reason: "created" | "updated" | "deleted" | "run_updated"
  },
): Promise<void> {
  try {
    await ownerScheduleFetch(env, ownerUserId, "/sync-alarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerUserId,
        ...(change ? { eventId: change.eventId, reason: change.reason } : {}),
      }),
    })
  } catch {
    // Best-effort alarm & WS sync; D1 already holds the authoritative state.
  }
}

export function parseFullMessageRef(rawRef: string): { channelRef: string; seq: number } | null {
  const trimmed = rawRef.trim()
  if (!trimmed) return null
  try {
    const parsed = parseRef(trimmed)
    if (typeof parsed.seq !== "number" || !Number.isInteger(parsed.seq) || parsed.seq <= 0) {
      return null
    }
    const channelRef = parsed.threadRootSeq !== undefined
      ? `/${parsed.server}/${parsed.channel}/#${parsed.threadRootSeq}`
      : `/${parsed.server}/${parsed.channel}`
    return { channelRef, seq: parsed.seq }
  } catch {
    return null
  }
}

export function parseScheduleRange(fromParam: string | null, toParam: string | null):
  | { ok: true; fromMs: number | null; toMs: number | null }
  | { ok: false; error: string } {
  if (fromParam === null && toParam === null) {
    return { ok: true, fromMs: null, toMs: null }
  }
  if (!fromParam || !toParam) {
    return { ok: false, error: "from and to query parameters must be provided together" }
  }
  const fromMs = Date.parse(fromParam)
  const toMs = Date.parse(toParam)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { ok: false, error: "from and to must be valid ISO timestamps" }
  }
  if (toMs <= fromMs) {
    return { ok: false, error: "to must be after from" }
  }
  if (toMs - fromMs > SCHEDULE_MAX_RANGE_MS) {
    return { ok: false, error: "date range cannot exceed 62 days" }
  }
  return { ok: true, fromMs, toMs }
}

export function normalizeHandleInput(handle: string): string {
  const trimmed = handle.trim()
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
}

export async function listHouseholdCreators(
  db: Database,
  ownerUserId: string,
): Promise<ScheduleActorSummary[]> {
  const botRows = await withD1Retry(
    () => queries.communityBot.listBotsForOwner(db, ownerUserId),
    { route: "schedule:owner-bots" },
  )

  return botRows.map((bot) => ({
    id: bot.id,
    handle: `@${formatHandle(bot.name, bot.discriminator)}`,
    name: bot.name,
    avatarVersion: bot.avatarVersion,
    isBot: true,
  }))
}

function toLastExecution(run: StoredScheduleRun | null | undefined): ScheduleLastExecution | null {
  if (!run) return null
  return {
    scheduledAt: new Date(run.scheduledAtMs).toISOString(),
    status: run.status,
    lastError: run.lastError,
    ackedAt: run.ackedAtMs !== null ? new Date(run.ackedAtMs).toISOString() : null,
    updatedAt: new Date(run.updatedAtMs).toISOString(),
  }
}

function summarizeMessagePreview(content: string | null | undefined): string | null {
  if (!content) return null
  const compact = content.replace(/\s+/g, " ").trim()
  if (!compact) return null
  return compact.length > 140 ? `${compact.slice(0, 140)}…` : compact
}

export async function hydrateScheduleEvents(
  db: Database,
  ownerUserId: string,
  callerUserId: string,
  storedEvents: readonly StoredScheduleEvent[],
  latestRunByEvent: Readonly<Record<string, StoredScheduleRun | null>>,
  knownCreators: readonly ScheduleActorSummary[],
): Promise<ScheduleEvent[]> {
  if (storedEvents.length === 0) return []

  const creatorMap = new Map<string, ScheduleActorSummary>(
    knownCreators.map((creator) => [creator.id, creator]),
  )
  const missingCreatorIds = [...new Set(
    storedEvents
      .map((event) => event.createdByUserId)
      .filter((id) => !creatorMap.has(id)),
  )]
  if (missingCreatorIds.length > 0) {
    const extraUsers = await withD1Retry(
      () => queries.user.getUsersByIds(db, missingCreatorIds),
      { route: "schedule:extra-creators" },
    )
    for (const u of extraUsers) {
      creatorMap.set(u.id, {
        id: u.id,
        handle: `@${formatHandle(u.name, u.discriminator)}`,
        name: u.name,
        avatarVersion: u.avatarVersion,
        isBot: u.id !== ownerUserId,
      })
    }
  }

  const distinctChannelIds = [...new Set(storedEvents.map((e) => e.sourceChannelId))]
  const distinctMessageIds = [...new Set(storedEvents.map((e) => e.sourceMessageId))]

  const channelAccessMap = new Map<string, { accessible: boolean; channelRef: string | null }>()
  await Promise.all(
    distinctChannelIds.map(async (channelId) => {
      const channelType = await withD1Retry(
        () => queries.communityChannel.getChannelType(db, channelId),
        { route: "schedule:channel-type" },
      )
      if (!channelType) {
        channelAccessMap.set(channelId, { accessible: false, channelRef: null })
        return
      }
      const gate = channelType === "dm"
        ? await requireDMAccess(db, channelId, callerUserId)
        : await requireChannelMember(db, channelId, callerUserId)
      if (!gate.ok) {
        channelAccessMap.set(channelId, { accessible: false, channelRef: null })
        return
      }
      const channelRef = await withD1Retry(
        () => queries.communityAgentInbox.resolveUnreadNoticeChannel(db, { channelId }, callerUserId),
        { route: "schedule:channel-ref" },
      )
      channelAccessMap.set(channelId, { accessible: true, channelRef })
    }),
  )

  const accessibleChannelIds = distinctChannelIds.filter((id) => channelAccessMap.get(id)?.accessible)
  const messageMap = new Map<string, { id: string; channelId: string; seq: number; content: string }>()
  if (accessibleChannelIds.length > 0) {
    const msgRows = await withD1Retry(
      () => queries.communityMessage.getMessagesByIdsInChannels(db, distinctMessageIds, accessibleChannelIds),
      { route: "schedule:source-messages" },
    )
    for (const row of msgRows) {
      messageMap.set(row.id, row)
    }
  }

  return storedEvents.map((event) => {
    const creator = creatorMap.get(event.createdByUserId) ?? {
      id: event.createdByUserId,
      handle: "@unknown#0000",
      name: "Unknown",
      avatarVersion: 0,
      isBot: true,
    }

    const access = channelAccessMap.get(event.sourceChannelId)
    let sourceMessage: ScheduleSourceMessage
    if (!access?.accessible) {
      sourceMessage = {
        id: event.sourceMessageId,
        accessible: false,
        status: "inaccessible",
        ref: null,
        channelRef: null,
        seq: null,
        preview: null,
      }
    } else {
      const msg = messageMap.get(event.sourceMessageId)
      if (!msg || msg.channelId !== event.sourceChannelId) {
        sourceMessage = {
          id: event.sourceMessageId,
          accessible: false,
          status: "deleted",
          ref: null,
          channelRef: null,
          seq: null,
          preview: null,
        }
      } else {
        const channelRef = access.channelRef
        sourceMessage = {
          id: event.sourceMessageId,
          accessible: true,
          status: "accessible",
          ref: channelRef ? `${channelRef}#${msg.seq}` : null,
          channelRef,
          seq: msg.seq,
          preview: summarizeMessagePreview(msg.content),
        }
      }
    }

    return {
      id: event.id,
      title: event.title,
      description: event.description,
      createdBy: creator,
      startAt: new Date(event.startAtMs).toISOString(),
      durationMinutes: event.durationMinutes,
      timeZone: event.timeZone,
      recurrence: event.recurrence,
      nextRunAt: event.nextRunAtMs !== null ? new Date(event.nextRunAtMs).toISOString() : null,
      sourceMessage,
      lastExecution: toLastExecution(latestRunByEvent[event.id]),
      createdAt: new Date(event.createdAtMs).toISOString(),
      updatedAt: new Date(event.updatedAtMs).toISOString(),
    }
  })
}

export function buildScheduleOccurrences(
  storedEvents: readonly StoredScheduleEvent[],
  runsByEvent: Readonly<Record<string, StoredScheduleRun[]>>,
  fromMs: number | null,
  toMs: number | null,
): ScheduleOccurrence[] {
  if (fromMs === null || toMs === null) return []
  const all: ScheduleOccurrence[] = []
  for (const event of storedEvents) {
    const runs = runsByEvent[event.id] ?? []
    const statusMap = new Map<number, ScheduleRunStatus>()
    for (const run of runs) {
      statusMap.set(run.scheduledAtMs, run.status)
    }
    const expanded = expandScheduleOccurrences(
      {
        id: event.id,
        startAtMs: event.startAtMs,
        durationMinutes: event.durationMinutes,
        timeZone: event.timeZone,
        recurrence: event.recurrence,
      },
      fromMs,
      toMs,
      statusMap,
    )
    all.push(...expanded)
  }
  all.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.eventId.localeCompare(b.eventId))
  return all
}

export function validateScheduleFields(input: {
  timeZone?: string
  startAt?: string
  durationMinutes?: number
  recurrence?: ScheduleRecurrence | null
}): { ok: true; startAtMs?: number; recurrence?: ScheduleRecurrence | null; durationMinutes?: number } | { ok: false; error: string } {
  if (input.timeZone !== undefined && !isValidIanaTimeZone(input.timeZone)) {
    return { ok: false, error: `invalid IANA timeZone: ${input.timeZone}` }
  }
  let startAtMs: number | undefined
  if (input.startAt !== undefined) {
    const parsed = Date.parse(input.startAt)
    if (!Number.isFinite(parsed)) return { ok: false, error: "invalid startAt timestamp" }
    startAtMs = parsed
  }
  const recurrence = input.recurrence === undefined ? undefined : normalizeRecurrence(input.recurrence)
  const durationMinutes = input.durationMinutes ?? SCHEDULE_DEFAULT_DURATION_MINUTES
  return { ok: true, startAtMs, recurrence, durationMinutes }
}
