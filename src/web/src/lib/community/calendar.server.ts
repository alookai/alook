import {
  CALENDAR_DEFAULT_DURATION_MINUTES,
  CALENDAR_MAX_RANGE_MS,
  expandCalendarOccurrences,
  formatHandle,
  isValidIanaTimeZone,
  normalizeRecurrence,
  parseRef,
  queries,
  withD1Retry,
  type CalendarActorSummary,
  type CalendarEvent,
  type CalendarLastExecution,
  type CalendarOccurrence,
  type CalendarRecurrence,
  type CalendarRunStatus,
  type CalendarSourceMessage,
  type Database,
  type StoredCalendarEvent,
  type StoredCalendarRun,
} from "@alook/shared"
import { wsDoFetch } from "@/lib/broadcast"
import { requireChannelMember, requireDMAccess } from "@/lib/community/permissions"
import type { CommunityActor } from "@/lib/middleware/community-actor"

export function calendarOwnerUserId(actor: CommunityActor): string {
  return actor.kind === "human" ? actor.userId : actor.ownerUserId
}

export function ownerCalendarFetch(
  env: Env,
  ownerUserId: string,
  innerPath: string,
  init: RequestInit = {},
): Promise<Response> {
  const path = `/owner-calendar/${encodeURIComponent(ownerUserId)}${innerPath}`
  return wsDoFetch(env, path, init, { label: ownerUserId, type: "owner-calendar" })
}

export async function syncOwnerCalendarAlarm(
  env: Env,
  ownerUserId: string,
  change?: {
    eventId: string
    reason: "created" | "updated" | "deleted" | "run_updated"
  },
): Promise<void> {
  try {
    await ownerCalendarFetch(env, ownerUserId, "/sync-alarm", {
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

export function parseCalendarRange(fromParam: string | null, toParam: string | null):
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
  if (toMs - fromMs > CALENDAR_MAX_RANGE_MS) {
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
): Promise<CalendarActorSummary[]> {
  const [ownerRows, botRows] = await Promise.all([
    withD1Retry(() => queries.user.getUsersByIds(db, [ownerUserId]), { route: "calendar:owner-profile" }),
    withD1Retry(() => queries.communityBot.listBotsForOwner(db, ownerUserId), { route: "calendar:owner-bots" }),
  ])

  const creators: CalendarActorSummary[] = []
  for (const bot of botRows) {
    creators.push({
      id: bot.id,
      handle: `@${formatHandle(bot.name, bot.discriminator)}`,
      name: bot.name,
      avatarVersion: bot.avatarVersion,
      isBot: true,
    })
  }
  const owner = ownerRows[0]
  if (owner) {
    creators.push({
      id: owner.id,
      handle: `@${formatHandle(owner.name, owner.discriminator)}`,
      name: owner.name,
      avatarVersion: owner.avatarVersion,
      isBot: false,
    })
  }
  return creators
}

function toLastExecution(run: StoredCalendarRun | null | undefined): CalendarLastExecution | null {
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

export async function hydrateCalendarEvents(
  db: Database,
  ownerUserId: string,
  callerUserId: string,
  storedEvents: readonly StoredCalendarEvent[],
  latestRunByEvent: Readonly<Record<string, StoredCalendarRun | null>>,
  knownCreators: readonly CalendarActorSummary[],
): Promise<CalendarEvent[]> {
  if (storedEvents.length === 0) return []

  const creatorMap = new Map<string, CalendarActorSummary>(
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
      { route: "calendar:extra-creators" },
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
        { route: "calendar:channel-type" },
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
        { route: "calendar:channel-ref" },
      )
      channelAccessMap.set(channelId, { accessible: true, channelRef })
    }),
  )

  const accessibleChannelIds = distinctChannelIds.filter((id) => channelAccessMap.get(id)?.accessible)
  const messageMap = new Map<string, { id: string; channelId: string; seq: number; content: string }>()
  if (accessibleChannelIds.length > 0) {
    const msgRows = await withD1Retry(
      () => queries.communityMessage.getMessagesByIdsInChannels(db, distinctMessageIds, accessibleChannelIds),
      { route: "calendar:source-messages" },
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
    let sourceMessage: CalendarSourceMessage
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
      paused: event.paused,
      sourceMessage,
      lastExecution: toLastExecution(latestRunByEvent[event.id]),
      createdAt: new Date(event.createdAtMs).toISOString(),
      updatedAt: new Date(event.updatedAtMs).toISOString(),
    }
  })
}

export function buildCalendarOccurrences(
  storedEvents: readonly StoredCalendarEvent[],
  runsByEvent: Readonly<Record<string, StoredCalendarRun[]>>,
  fromMs: number | null,
  toMs: number | null,
): CalendarOccurrence[] {
  if (fromMs === null || toMs === null) return []
  const all: CalendarOccurrence[] = []
  for (const event of storedEvents) {
    const runs = runsByEvent[event.id] ?? []
    const statusMap = new Map<number, CalendarRunStatus>()
    for (const run of runs) {
      statusMap.set(run.scheduledAtMs, run.status)
    }
    const expanded = expandCalendarOccurrences(
      {
        id: event.id,
        startAtMs: event.startAtMs,
        durationMinutes: event.durationMinutes,
        timeZone: event.timeZone,
        recurrence: event.recurrence,
        paused: event.paused,
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

export function validateCalendarScheduleFields(input: {
  timeZone?: string
  startAt?: string
  durationMinutes?: number
  recurrence?: CalendarRecurrence | null
}): { ok: true; startAtMs?: number; recurrence?: CalendarRecurrence | null; durationMinutes?: number } | { ok: false; error: string } {
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
  const durationMinutes = input.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES
  return { ok: true, startAtMs, recurrence, durationMinutes }
}

export async function resyncOwnerCalendarForBots(
  db: Database,
  env: Env,
  ownerUserId: string,
  botIds: readonly string[],
): Promise<{ attempted: number; dispatched: number; blocked: number }> {
  if (botIds.length === 0) return { attempted: 0, dispatched: 0, blocked: 0 }
  try {
    const pendingRuns = await withD1Retry(
      () => queries.communityCalendar.listPendingRunsForOwner(db, ownerUserId, 50),
      { route: "calendar:resync-check-pending" },
    )
    const botIdSet = new Set(botIds)
    if (!pendingRuns.some((run) => botIdSet.has(run.botUserId))) {
      return { attempted: 0, dispatched: 0, blocked: 0 }
    }
    const res = await ownerCalendarFetch(env, ownerUserId, "/resync-bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId, botIds }),
    })
    if (!res.ok) return { attempted: 0, dispatched: 0, blocked: 0 }
    const data = (await res.json()) as { attempted?: number; dispatched?: number; blocked?: number }
    return {
      attempted: typeof data.attempted === "number" ? data.attempted : 0,
      dispatched: typeof data.dispatched === "number" ? data.dispatched : 0,
      blocked: typeof data.blocked === "number" ? data.blocked : 0,
    }
  } catch {
    return { attempted: 0, dispatched: 0, blocked: 0 }
  }
}
