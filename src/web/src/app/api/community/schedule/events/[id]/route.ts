import { NextRequest } from "next/server"
import { queries, ScheduleUpdateRequestSchema, withD1Retry } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth-policy"
import { communityActorPolicy, requireBot } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { resolveMessageRefForBot } from "@/lib/community/resolve-message-ref"
import {
  hydrateScheduleEvents,
  listHouseholdCreators,
  parseFullMessageRef,
  scheduleOwnerUserId,
  syncOwnerScheduleAlarm,
  validateScheduleFields,
} from "@/lib/community/schedule.server"

export const GET = withAuth(communityActorPolicy(), async (_req: NextRequest, ctx) => {
  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = scheduleOwnerUserId(ctx.actor)
  const payload = await withD1Retry(
    () => queries.communitySchedule.getScheduleEventById(db, ownerUserId, eventId),
    { route: "schedule:get-one" },
  )
  if (!payload) return writeError("schedule event not found", 404)

  const creators = await listHouseholdCreators(db, ownerUserId)
  const [event] = await hydrateScheduleEvents(
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
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const bot = gate.bot

  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  let rawBody: unknown
  try {
    rawBody = await req.json()
  } catch {
    return writeError("invalid JSON body", 400)
  }

  const parsed = ScheduleUpdateRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return writeError(parsed.error.issues[0]?.message ?? "invalid schedule update payload", 400)
  }

  const scheduleCheck = validateScheduleFields({
    timeZone: parsed.data.timeZone,
    startAt: parsed.data.startAt,
    durationMinutes: parsed.data.durationMinutes,
    recurrence: parsed.data.recurrence,
  })
  if (!scheduleCheck.ok) return writeError(scheduleCheck.error, 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = bot.ownerUserId

  let sourceMessageId: string | undefined
  let sourceChannelId: string | undefined
  if (parsed.data.sourceMessageRef !== undefined) {
    const refParts = parseFullMessageRef(parsed.data.sourceMessageRef)
    if (!refParts) {
      return writeError("sourceMessageRef must be a full message ref such as /Server#1234/channel#42 or /.dm/peer#12", 400)
    }
    const resolvedMessage = await resolveMessageRefForBot(
      db,
      bot.userId,
      { channel: refParts.channelRef, seq: refParts.seq },
      { requireSurfaceAccess: true },
    )
    if (!resolvedMessage.ok) {
      return writeError(resolvedMessage.error, resolvedMessage.status)
    }
    const current = await withD1Retry(
      () => queries.communitySchedule.getScheduleEventById(db, ownerUserId, eventId),
      { route: "schedule:verify-event" },
    )
    if (!current) return writeError("schedule event not found", 404)
    if (current.event.createdByUserId !== bot.userId) {
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
    () => queries.communitySchedule.updateScheduleEvent(db, ownerUserId, eventId, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(scheduleCheck.startAtMs !== undefined ? { startAtMs: scheduleCheck.startAtMs } : {}),
      ...(parsed.data.durationMinutes !== undefined ? { durationMinutes: parsed.data.durationMinutes } : {}),
      ...(parsed.data.timeZone !== undefined ? { timeZone: parsed.data.timeZone } : {}),
      ...(hasRecurrence ? { hasRecurrence: true, recurrence: scheduleCheck.recurrence ?? null } : {}),
      ...(sourceMessageId !== undefined ? { sourceMessageId, sourceChannelId } : {}),
      ...(parsed.data.ack === true ? { ack: true } : {}),
    }),
    { route: "schedule:update" },
  )

  if (!updated.ok) {
    return writeError(updated.error, updated.code === "not_found" ? 404 : 409)
  }

  await syncOwnerScheduleAlarm(ctx.env, ownerUserId, {
    eventId,
    reason: parsed.data.ack === true ? "run_updated" : "updated",
  })

  const creators = await listHouseholdCreators(db, ownerUserId)
  const [event] = await hydrateScheduleEvents(
    db,
    ownerUserId,
    bot.userId,
    [updated.event],
    { [updated.event.id]: updated.latestRun },
    creators,
  )
  return writeJSON({ event })
})

export const DELETE = withAuth(communityActorPolicy(), async (_req: NextRequest, ctx) => {
  const gate = requireBot(ctx.actor)
  if (!gate.ok) return gate.response
  const bot = gate.bot

  const eventId = ctx.params?.id?.trim()
  if (!eventId) return writeError("missing event id", 400)

  const db = getDb(ctx.env.DB)
  const ownerUserId = bot.ownerUserId
  const deleted = await withD1Retry(
    () => queries.communitySchedule.deleteScheduleEvent(db, ownerUserId, eventId),
    { route: "schedule:delete" },
  )
  if (!deleted) return writeError("schedule event not found", 404)

  await syncOwnerScheduleAlarm(ctx.env, ownerUserId, {
    eventId,
    reason: "deleted",
  })

  return new Response(null, { status: 204 })
})
