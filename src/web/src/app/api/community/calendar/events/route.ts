import { NextRequest } from "next/server"
import {
  CALENDAR_DEFAULT_DURATION_MINUTES,
  CALENDAR_MAX_EVENTS_PER_OWNER,
  CalendarCreateRequestSchema,
  queries,
  withD1Retry,
} from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { resolveMessageRefForBot } from "@/lib/community/resolve-message-ref"
import {
  buildCalendarOccurrences,
  calendarOwnerUserId,
  hydrateCalendarEvents,
  listHouseholdCreators,
  normalizeHandleInput,
  parseCalendarRange,
  parseFullMessageRef,
  syncOwnerCalendarAlarm,
  validateCalendarScheduleFields,
} from "@/lib/community/calendar.server"

export const GET = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const ownerUserId = calendarOwnerUserId(ctx.actor)
  const params = req.nextUrl.searchParams

  const range = parseCalendarRange(params.get("from"), params.get("to"))
  if (!range.ok) return writeError(range.error, 400)

  const includePaused = params.get("includePaused") !== "false"
  const creators = await listHouseholdCreators(db, ownerUserId)

  let creatorId = params.get("creatorId")?.trim() || null
  const creatorHandle = params.get("creatorHandle")?.trim() || null
  if (creatorHandle) {
    const normalized = normalizeHandleInput(creatorHandle).toLowerCase()
    const matched = creators.find((c) => normalizeHandleInput(c.handle).toLowerCase() === normalized)
    if (!matched) {
      return writeJSON({ events: [], occurrences: [], creators })
    }
    creatorId = matched.id
  }

  const payload = await withD1Retry(
    () => queries.communityCalendar.listOwnerCalendarEvents(db, ownerUserId, {
      creatorId,
      includePaused,
      fromMs: range.fromMs,
      toMs: range.toMs,
    }),
    { route: "calendar:list" },
  )

  const events = await hydrateCalendarEvents(
    db,
    ownerUserId,
    ctx.actor.userId,
    payload.events,
    payload.latestRunByEvent,
    creators,
  )
  const occurrences = buildCalendarOccurrences(
    payload.events,
    payload.runsByEvent,
    range.fromMs,
    range.toMs,
  )

  return writeJSON({ events, occurrences, creators })
})

export const POST = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const bot = gate.bot

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return writeError("invalid JSON body", 400)
  }

  const parsed = CalendarCreateRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return writeError(parsed.error.issues[0]?.message ?? "invalid calendar event payload", 400)
  }

  const scheduleCheck = validateCalendarScheduleFields({
    timeZone: parsed.data.timeZone,
    startAt: parsed.data.startAt,
    durationMinutes: parsed.data.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES,
    recurrence: parsed.data.recurrence ?? null,
  })
  if (!scheduleCheck.ok || scheduleCheck.startAtMs === undefined) {
    return writeError(scheduleCheck.ok ? "invalid startAt" : scheduleCheck.error, 400)
  }

  const refParts = parseFullMessageRef(parsed.data.sourceMessageRef)
  if (!refParts) {
    return writeError("sourceMessageRef must be a full message ref such as /Server#1234/channel#42 or /.dm/peer#12", 400)
  }

  const db = getDb(ctx.env.DB)
  const resolvedMessage = await resolveMessageRefForBot(
    db,
    bot.userId,
    { channel: refParts.channelRef, seq: refParts.seq },
    { requireSurfaceAccess: true },
  )
  if (!resolvedMessage.ok) {
    return writeError(resolvedMessage.error, resolvedMessage.status)
  }

  const created = await withD1Retry(
    () => queries.communityCalendar.createCalendarEvent(db, {
      ownerUserId: bot.ownerUserId,
      createdByUserId: bot.userId,
      title: parsed.data.title,
      description: parsed.data.description ?? "",
      startAtMs: scheduleCheck.startAtMs!,
      durationMinutes: parsed.data.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES,
      timeZone: parsed.data.timeZone,
      recurrence: scheduleCheck.recurrence ?? null,
      sourceMessageId: resolvedMessage.messageId,
      sourceChannelId: resolvedMessage.channelId,
    }),
    { route: "calendar:create" },
  )

  if (!created.ok) {
    return writeError(`calendar event limit reached (${CALENDAR_MAX_EVENTS_PER_OWNER})`, 409)
  }

  await syncOwnerCalendarAlarm(ctx.env, bot.ownerUserId, {
    eventId: created.event.id,
    reason: "created",
  })

  const creators = await listHouseholdCreators(db, bot.ownerUserId)
  const [event] = await hydrateCalendarEvents(
    db,
    bot.ownerUserId,
    bot.userId,
    [created.event],
    { [created.event.id]: created.latestRun },
    creators,
  )

  return writeJSON({ event }, 201)
})
