import { NextRequest } from "next/server"
import { CalendarUpdateRequestSchema, queries, withD1Retry } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { resolveMessageRefForBot } from "@/lib/community/resolve-message-ref"
import {
  calendarOwnerUserId,
  hydrateCalendarEvents,
  listHouseholdCreators,
  parseFullMessageRef,
  syncOwnerCalendarAlarm,
  validateCalendarScheduleFields,
} from "@/lib/community/calendar.server"

export const GET = withAuth(communityActorPolicy(), async (_req: NextRequest, ctx) => {
  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = calendarOwnerUserId(ctx.actor)
  const payload = await withD1Retry(
    () => queries.communityCalendar.getCalendarEventById(db, ownerUserId, eventId),
    { route: "calendar:get-one" },
  )
  if (!payload) return writeError("calendar event not found", 404)

  const creators = await listHouseholdCreators(db, ownerUserId)
  const [event] = await hydrateCalendarEvents(
    db,
    ownerUserId,
    ctx.actor.userId,
    [payload.event],
    { [payload.event.id]: payload.latestRun },
    creators,
  )
  return writeJSON({ event })
})

export const PATCH = withAuth(communityActorPolicy(), async (req: NextRequest, ctx) => {
  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return writeError("invalid JSON body", 400)
  }

  const parsed = CalendarUpdateRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return writeError(parsed.error.issues[0]?.message ?? "invalid calendar update payload", 400)
  }

  const scheduleCheck = validateCalendarScheduleFields({
    timeZone: parsed.data.timeZone,
    startAt: parsed.data.startAt,
    durationMinutes: parsed.data.durationMinutes,
    recurrence: parsed.data.recurrence,
  })
  if (!scheduleCheck.ok) return writeError(scheduleCheck.error, 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = calendarOwnerUserId(ctx.actor)

  let sourceMessageId: string | undefined
  let sourceChannelId: string | undefined
  if (parsed.data.sourceMessageRef !== undefined) {
    if (ctx.actor.kind !== "bot") {
      return writeError("re-binding sourceMessageRef is only supported via bot CLI", 400)
    }
    const refParts = parseFullMessageRef(parsed.data.sourceMessageRef)
    if (!refParts) {
      return writeError("sourceMessageRef must be a full message ref such as /Server#1234/channel#42 or /.dm/peer#12", 400)
    }
    const resolvedMessage = await resolveMessageRefForBot(
      db,
      ctx.actor.userId,
      { channel: refParts.channelRef, seq: refParts.seq },
      { requireSurfaceAccess: true },
    )
    if (!resolvedMessage.ok) {
      return writeError(resolvedMessage.error, resolvedMessage.status)
    }
    const current = await withD1Retry(
      () => queries.communityCalendar.getCalendarEventById(db, ownerUserId, eventId),
      { route: "calendar:verify-event" },
    )
    if (!current) return writeError("calendar event not found", 404)
    if (current.event.createdByUserId !== ctx.actor.userId) {
      const creatorAccess = await requireMessageSurfaceAccess(
        db,
        resolvedMessage.channelId,
        current.event.createdByUserId,
      )
      if (!creatorAccess.ok) {
        return writeError("event creator bot cannot access the target message", 403)
      }
    }
    sourceMessageId = resolvedMessage.messageId
    sourceChannelId = resolvedMessage.channelId
  }

  const hasRecurrence = Object.prototype.hasOwnProperty.call(rawBody as Record<string, unknown>, "recurrence")
  const updated = await withD1Retry(
    () => queries.communityCalendar.updateCalendarEvent(db, ownerUserId, eventId, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(scheduleCheck.startAtMs !== undefined ? { startAtMs: scheduleCheck.startAtMs } : {}),
      ...(parsed.data.durationMinutes !== undefined ? { durationMinutes: parsed.data.durationMinutes } : {}),
      ...(parsed.data.timeZone !== undefined ? { timeZone: parsed.data.timeZone } : {}),
      ...(hasRecurrence ? { hasRecurrence: true, recurrence: scheduleCheck.recurrence ?? null } : {}),
      ...(sourceMessageId !== undefined ? { sourceMessageId, sourceChannelId } : {}),
      ...(parsed.data.ack === true ? { ack: true } : {}),
    }),
    { route: "calendar:update" },
  )

  if (!updated.ok) {
    return writeError(updated.error, updated.code === "not_found" ? 404 : 409)
  }

  await syncOwnerCalendarAlarm(ctx.env, ownerUserId, {
    eventId,
    reason: parsed.data.ack === true ? "run_updated" : "updated",
  })

  const creators = await listHouseholdCreators(db, ownerUserId)
  const [event] = await hydrateCalendarEvents(
    db,
    ownerUserId,
    ctx.actor.userId,
    [updated.event],
    { [updated.event.id]: updated.latestRun },
    creators,
  )
  return writeJSON({ event })
})

export const DELETE = withAuth(communityActorPolicy(), async (_req: NextRequest, ctx) => {
  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = calendarOwnerUserId(ctx.actor)
  const deleted = await withD1Retry(
    () => queries.communityCalendar.deleteCalendarEvent(db, ownerUserId, eventId),
    { route: "calendar:delete" },
  )
  if (!deleted) return writeError("calendar event not found", 404)

  await syncOwnerCalendarAlarm(ctx.env, ownerUserId, {
    eventId,
    reason: "deleted",
  })

  return new Response(null, { status: 204 })
})
