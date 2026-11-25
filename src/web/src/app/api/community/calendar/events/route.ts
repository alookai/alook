import { NextRequest } from "next/server"
import { CalendarCreateRequestSchema, CALENDAR_DEFAULT_DURATION_MINUTES } from "@alook/shared"
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
  ownerCalendarFetch,
  parseCalendarRange,
  parseFullMessageRef,
  validateCalendarScheduleFields,
  type StoredCalendarEvent,
  type StoredCalendarRun,
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

  const query = new URLSearchParams()
  if (creatorId) query.set("creatorId", creatorId)
  if (!includePaused) query.set("includePaused", "false")
  if (range.fromMs !== null && range.toMs !== null) {
    query.set("fromMs", String(range.fromMs))
    query.set("toMs", String(range.toMs))
  }

  const doRes = await ownerCalendarFetch(ctx.env, ownerUserId, `/events${query.size > 0 ? `?${query}` : ""}`, {
    method: "GET",
  })
  if (!doRes.ok) {
    return writeError("failed to load calendar events", 502)
  }

  const payload = (await doRes.json()) as {
    events: StoredCalendarEvent[]
    runsByEvent: Record<string, StoredCalendarRun[]>
    latestRunByEvent: Record<string, StoredCalendarRun | null>
  }

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

  const doRes = await ownerCalendarFetch(ctx.env, bot.ownerUserId, "/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ownerUserId: bot.ownerUserId,
      createdByUserId: bot.userId,
      title: parsed.data.title,
      description: parsed.data.description ?? "",
      startAtMs: scheduleCheck.startAtMs,
      durationMinutes: parsed.data.durationMinutes ?? CALENDAR_DEFAULT_DURATION_MINUTES,
      timeZone: parsed.data.timeZone,
      recurrence: scheduleCheck.recurrence ?? null,
      sourceMessageId: resolvedMessage.messageId,
      sourceChannelId: resolvedMessage.channelId,
    }),
  })
  if (!doRes.ok) {
    const errBody = (await doRes.json().catch(() => ({}))) as { error?: string }
    return writeError(errBody.error ?? "failed to create calendar event", doRes.status >= 400 && doRes.status < 500 ? doRes.status : 502)
  }

  const created = (await doRes.json()) as {
    event: StoredCalendarEvent
    latestRun: StoredCalendarRun | null
  }
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
