import { z } from "zod"

export const SCHEDULE_TITLE_MAX_LENGTH = 160
export const SCHEDULE_DESCRIPTION_MAX_LENGTH = 4000
export const SCHEDULE_DEFAULT_DURATION_MINUTES = 30
export const SCHEDULE_MIN_DURATION_MINUTES = 5
export const SCHEDULE_MAX_DURATION_MINUTES = 1440
export const SCHEDULE_MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000
export const SCHEDULE_MAX_OCCURRENCES_PER_EVENT = 200
export const SCHEDULE_MAX_EVENTS_PER_OWNER = 200

export const ScheduleRecurrenceFreqSchema = z.enum(["hourly", "daily", "weekly", "monthly"])
export type ScheduleRecurrenceFreq = z.infer<typeof ScheduleRecurrenceFreqSchema>

export const ScheduleRecurrenceSchema = z.strictObject({
  freq: ScheduleRecurrenceFreqSchema,
  interval: z.number().int().min(1).max(365),
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  untilAt: z.iso.datetime({ offset: true }).nullable().optional(),
  count: z.number().int().min(1).max(1000).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.byWeekday !== undefined && value.freq !== "weekly") {
    ctx.addIssue({
      code: "custom",
      path: ["byWeekday"],
      message: "byWeekday is only supported for weekly recurrence",
    })
  }
})
export type ScheduleRecurrence = z.infer<typeof ScheduleRecurrenceSchema>

export const ScheduleRunStatusSchema = z.enum([
  "pending",
  "dispatched",
  "completed",
  "blocked_access",
])
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>

export const ScheduleOccurrenceStatusSchema = z.enum([
  "scheduled",
  "pending",
  "dispatched",
  "completed",
  "blocked_access",
])
export type ScheduleOccurrenceStatus = z.infer<typeof ScheduleOccurrenceStatusSchema>

export const ScheduleSourceMessageStatusSchema = z.enum([
  "accessible",
  "inaccessible",
  "deleted",
])
export type ScheduleSourceMessageStatus = z.infer<typeof ScheduleSourceMessageStatusSchema>

export const ScheduleActorSummarySchema = z.strictObject({
  id: z.string().min(1),
  handle: z.string().min(1),
  name: z.string().min(1),
  avatarVersion: z.number().int().nonnegative(),
  isBot: z.boolean(),
})
export type ScheduleActorSummary = z.infer<typeof ScheduleActorSummarySchema>

export const ScheduleLastExecutionSchema = z.strictObject({
  scheduledAt: z.iso.datetime(),
  status: ScheduleRunStatusSchema,
  lastError: z.string().nullable(),
  ackedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
})
export type ScheduleLastExecution = z.infer<typeof ScheduleLastExecutionSchema>

export const ScheduleSourceMessageSchema = z.strictObject({
  id: z.string().min(1),
  accessible: z.boolean(),
  status: ScheduleSourceMessageStatusSchema,
  ref: z.string().nullable(),
  channelRef: z.string().nullable(),
  seq: z.number().int().positive().nullable(),
  preview: z.string().nullable(),
})
export type ScheduleSourceMessage = z.infer<typeof ScheduleSourceMessageSchema>

export const ScheduleEventSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  createdBy: ScheduleActorSummarySchema,
  startAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(SCHEDULE_MIN_DURATION_MINUTES).max(SCHEDULE_MAX_DURATION_MINUTES),
  timeZone: z.string().min(1),
  recurrence: ScheduleRecurrenceSchema.nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  sourceMessage: ScheduleSourceMessageSchema,
  lastExecution: ScheduleLastExecutionSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>

export const ScheduleOccurrenceSchema = z.strictObject({
  eventId: z.string().min(1),
  occurrenceKey: z.string().min(1),
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
  runStatus: ScheduleOccurrenceStatusSchema,
})
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>

export const ScheduleListResponseSchema = z.strictObject({
  events: z.array(ScheduleEventSchema),
  occurrences: z.array(ScheduleOccurrenceSchema),
  creators: z.array(ScheduleActorSummarySchema),
})
export type ScheduleListResponse = z.infer<typeof ScheduleListResponseSchema>

export const ScheduleCreateRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX_LENGTH),
  description: z.string().max(SCHEDULE_DESCRIPTION_MAX_LENGTH).optional(),
  startAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.number().int().min(SCHEDULE_MIN_DURATION_MINUTES).max(SCHEDULE_MAX_DURATION_MINUTES).optional(),
  timeZone: z.string().trim().min(1).max(128),
  recurrence: ScheduleRecurrenceSchema.nullable().optional(),
  sourceMessageRef: z.string().trim().min(1).max(512),
})
export type ScheduleCreateRequest = z.infer<typeof ScheduleCreateRequestSchema>

export const ScheduleUpdateRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(SCHEDULE_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(SCHEDULE_DESCRIPTION_MAX_LENGTH).optional(),
  startAt: z.iso.datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(SCHEDULE_MIN_DURATION_MINUTES).max(SCHEDULE_MAX_DURATION_MINUTES).optional(),
  timeZone: z.string().trim().min(1).max(128).optional(),
  recurrence: ScheduleRecurrenceSchema.nullable().optional(),
  sourceMessageRef: z.string().trim().min(1).max(512).optional(),
  ack: z.literal(true).optional(),
})
export type ScheduleUpdateRequest = z.infer<typeof ScheduleUpdateRequestSchema>

export function normalizeRecurrence(recurrence: ScheduleRecurrence | null | undefined): ScheduleRecurrence | null {
  if (!recurrence) return null
  const byWeekday = recurrence.freq === "weekly" && recurrence.byWeekday
    ? [...new Set(recurrence.byWeekday)].sort((a, b) => a - b)
    : undefined
  const untilAt = recurrence.untilAt ? new Date(recurrence.untilAt).toISOString() : null
  const count = recurrence.count ?? null
  return {
    freq: recurrence.freq,
    interval: recurrence.interval,
    ...(byWeekday ? { byWeekday } : {}),
    ...(untilAt !== null ? { untilAt } : {}),
    ...(count !== null ? { count } : {}),
  }
}

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0)
    return true
  } catch {
    return false
  }
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getTimeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
    if (formatterCache.size > 64) formatterCache.clear()
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

export interface ZonedDateTimeParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

export function getZonedParts(utcMs: number, timeZone: string): ZonedDateTimeParts {
  const parts = getTimeZoneFormatter(timeZone).formatToParts(new Date(utcMs))
  let year = 1970
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let second = 0
  let weekday = 0
  for (const part of parts) {
    switch (part.type) {
      case "year": year = Number(part.value); break
      case "month": month = Number(part.value); break
      case "day": day = Number(part.value); break
      case "hour": hour = Number(part.value) % 24; break
      case "minute": minute = Number(part.value); break
      case "second": second = Number(part.value); break
      case "weekday": weekday = WEEKDAY_MAP[part.value] ?? 0; break
    }
  }
  return { year, month, day, hour, minute, second, weekday }
}

function partsToUtcWallMs(parts: Pick<ZonedDateTimeParts, "year" | "month" | "day" | "hour" | "minute" | "second">): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0)
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function addUtcDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day + deltaDays))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}

export function utcDaySerial(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

export function zonedDateTimeToUtcMs(
  wall: Pick<ZonedDateTimeParts, "year" | "month" | "day" | "hour" | "minute" | "second">,
  timeZone: string,
): number {
  const desiredWallMs = partsToUtcWallMs(wall)
  let guess = desiredWallMs
  for (let i = 0; i < 4; i++) {
    const actual = getZonedParts(guess, timeZone)
    const actualWallMs = partsToUtcWallMs(actual)
    const diff = desiredWallMs - actualWallMs
    if (diff === 0) break
    guess += diff
  }
  const probe = getZonedParts(guess, timeZone)
  if (partsToUtcWallMs(probe) !== desiredWallMs) {
    const earlier = guess - 3_600_000
    const earlierOffset = partsToUtcWallMs(getZonedParts(earlier, timeZone)) - earlier
    return desiredWallMs - earlierOffset
  }
  const oneHourEarlier = guess - 3_600_000
  if (partsToUtcWallMs(getZonedParts(oneHourEarlier, timeZone)) === desiredWallMs) {
    return oneHourEarlier
  }
  return guess
}

export interface ScheduleSpec {
  startAtMs: number
  timeZone: string
  recurrence: ScheduleRecurrence | null
}

function effectiveWeekdays(recurrence: ScheduleRecurrence, anchorWeekday: number): number[] {
  if (recurrence.byWeekday && recurrence.byWeekday.length > 0) {
    return [...new Set(recurrence.byWeekday)].sort((a, b) => a - b)
  }
  return [anchorWeekday]
}

function untilLimitMs(recurrence: ScheduleRecurrence | null): number | null {
  if (!recurrence?.untilAt) return null
  const ms = Date.parse(recurrence.untilAt)
  return Number.isFinite(ms) ? ms : null
}

export function computeFirstOccurrenceMs(spec: ScheduleSpec): number | null {
  const recurrence = normalizeRecurrence(spec.recurrence)
  if (!recurrence) return spec.startAtMs

  const untilMs = untilLimitMs(recurrence)
  if (recurrence.freq !== "weekly" || !recurrence.byWeekday || recurrence.byWeekday.length === 0) {
    if (untilMs !== null && spec.startAtMs > untilMs) return null
    return spec.startAtMs
  }

  const anchor = getZonedParts(spec.startAtMs, spec.timeZone)
  const weekdays = effectiveWeekdays(recurrence, anchor.weekday)
  const sameWeekDay = weekdays.find((d) => d >= anchor.weekday)
  let candidateMs: number

  if (sameWeekDay !== undefined) {
    const delta = sameWeekDay - anchor.weekday
    const targetDate = addUtcDays(anchor.year, anchor.month, anchor.day, delta)
    candidateMs = delta === 0
      ? spec.startAtMs
      : zonedDateTimeToUtcMs({ ...targetDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second }, spec.timeZone)
  } else {
    const delta = -anchor.weekday + recurrence.interval * 7 + weekdays[0]!
    const targetDate = addUtcDays(anchor.year, anchor.month, anchor.day, delta)
    candidateMs = zonedDateTimeToUtcMs({ ...targetDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second }, spec.timeZone)
  }

  if (untilMs !== null && candidateMs > untilMs) return null
  return candidateMs
}

export function computeNextOccurrenceAfter(
  spec: ScheduleSpec,
  currentOccurrenceMs: number,
  occurrenceCountAfterCurrent: number,
): number | null {
  const recurrence = normalizeRecurrence(spec.recurrence)
  if (!recurrence) return null
  if (recurrence.count != null && occurrenceCountAfterCurrent >= recurrence.count) return null

  const untilMs = untilLimitMs(recurrence)
  let nextMs: number

  if (recurrence.freq === "hourly") {
    nextMs = currentOccurrenceMs + recurrence.interval * 3_600_000
  } else if (recurrence.freq === "daily") {
    const anchor = getZonedParts(spec.startAtMs, spec.timeZone)
    const current = getZonedParts(currentOccurrenceMs, spec.timeZone)
    const targetDate = addUtcDays(current.year, current.month, current.day, recurrence.interval)
    nextMs = zonedDateTimeToUtcMs(
      { ...targetDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
      spec.timeZone,
    )
    if (nextMs <= currentOccurrenceMs) {
      const fallback = addUtcDays(targetDate.year, targetDate.month, targetDate.day, recurrence.interval)
      nextMs = zonedDateTimeToUtcMs(
        { ...fallback, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
        spec.timeZone,
      )
    }
  } else if (recurrence.freq === "weekly") {
    const anchor = getZonedParts(spec.startAtMs, spec.timeZone)
    const current = getZonedParts(currentOccurrenceMs, spec.timeZone)
    const weekdays = effectiveWeekdays(recurrence, anchor.weekday)
    const laterInWeek = weekdays.find((d) => d > current.weekday)
    const deltaDays = laterInWeek !== undefined
      ? laterInWeek - current.weekday
      : -current.weekday + recurrence.interval * 7 + weekdays[0]!
    const targetDate = addUtcDays(current.year, current.month, current.day, deltaDays)
    nextMs = zonedDateTimeToUtcMs(
      { ...targetDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
      spec.timeZone,
    )
  } else {
    const anchor = getZonedParts(spec.startAtMs, spec.timeZone)
    const current = getZonedParts(currentOccurrenceMs, spec.timeZone)
    const anchorMonths = anchor.year * 12 + (anchor.month - 1)
    const currentMonths = current.year * 12 + (current.month - 1)
    const stepsCompleted = Math.max(0, Math.floor((currentMonths - anchorMonths) / recurrence.interval))
    const nextTotalMonths = anchorMonths + (stepsCompleted + 1) * recurrence.interval
    const targetYear = Math.floor(nextTotalMonths / 12)
    const targetMonth = (nextTotalMonths % 12) + 1
    const targetDay = Math.min(anchor.day, daysInMonth(targetYear, targetMonth))
    nextMs = zonedDateTimeToUtcMs(
      { year: targetYear, month: targetMonth, day: targetDay, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
      spec.timeZone,
    )
  }

  if (untilMs !== null && nextMs > untilMs) return null
  return nextMs
}

export function advanceNextRunAfterFire(
  spec: ScheduleSpec,
  firedAtMs: number,
  occurrenceCountAfterFire: number,
  nowMs: number,
): { nextRunAtMs: number | null; occurrenceCount: number } {
  const recurrence = normalizeRecurrence(spec.recurrence)
  if (!recurrence) {
    return { nextRunAtMs: null, occurrenceCount: occurrenceCountAfterFire }
  }

  let count = occurrenceCountAfterFire
  let next = computeNextOccurrenceAfter(spec, firedAtMs, count)
  if (next === null) return { nextRunAtMs: null, occurrenceCount: count }

  if (next <= nowMs) {
    const fast = fastForwardToOrAfter(spec, next, count, nowMs + 1)
    next = fast.occurrenceMs
    count = fast.priorCount
  }

  return { nextRunAtMs: next, occurrenceCount: count }
}

function fastForwardToOrAfter(
  spec: ScheduleSpec,
  firstCandidateMs: number,
  priorCountAtFirst: number,
  targetMs: number,
): { occurrenceMs: number | null; priorCount: number } {
  const recurrence = normalizeRecurrence(spec.recurrence)
  if (!recurrence) return { occurrenceMs: firstCandidateMs >= targetMs ? firstCandidateMs : null, priorCount: priorCountAtFirst }

  let current = firstCandidateMs
  let priorCount = priorCountAtFirst

  if (current < targetMs) {
    const anchor = getZonedParts(spec.startAtMs, spec.timeZone)
    if (recurrence.freq === "hourly") {
      const stepMs = recurrence.interval * 3_600_000
      const skip = Math.max(0, Math.floor((targetMs - current) / stepMs))
      if (skip > 0) {
        if (recurrence.count != null && priorCount + skip >= recurrence.count) {
          return { occurrenceMs: null, priorCount: recurrence.count }
        }
        current += skip * stepMs
        priorCount += skip
      }
    } else if (recurrence.freq === "daily") {
      const curParts = getZonedParts(current, spec.timeZone)
      const targetParts = getZonedParts(targetMs, spec.timeZone)
      const dayDelta = utcDaySerial(targetParts.year, targetParts.month, targetParts.day)
        - utcDaySerial(curParts.year, curParts.month, curParts.day)
      const skip = Math.max(0, Math.floor(dayDelta / recurrence.interval) - 1)
      if (skip > 0) {
        if (recurrence.count != null && priorCount + skip >= recurrence.count) {
          return { occurrenceMs: null, priorCount: recurrence.count }
        }
        const jumpedDate = addUtcDays(curParts.year, curParts.month, curParts.day, skip * recurrence.interval)
        current = zonedDateTimeToUtcMs(
          { ...jumpedDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
          spec.timeZone,
        )
        priorCount += skip
      }
    } else if (recurrence.freq === "weekly") {
      const curParts = getZonedParts(current, spec.timeZone)
      const targetParts = getZonedParts(targetMs, spec.timeZone)
      const weekdays = effectiveWeekdays(recurrence, anchor.weekday)
      const curWeekStartSerial = utcDaySerial(curParts.year, curParts.month, curParts.day) - curParts.weekday
      const targetWeekStartSerial = utcDaySerial(targetParts.year, targetParts.month, targetParts.day) - targetParts.weekday
      const weekStepDays = recurrence.interval * 7
      const fullBlocks = Math.max(0, Math.floor((targetWeekStartSerial - curWeekStartSerial) / weekStepDays) - 1)
      if (fullBlocks > 0) {
        const skippedOccurrences = fullBlocks * weekdays.length
        if (recurrence.count != null && priorCount + skippedOccurrences >= recurrence.count) {
          return { occurrenceMs: null, priorCount: recurrence.count }
        }
        const jumpedDate = addUtcDays(curParts.year, curParts.month, curParts.day, fullBlocks * weekStepDays)
        current = zonedDateTimeToUtcMs(
          { ...jumpedDate, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
          spec.timeZone,
        )
        priorCount += skippedOccurrences
      }
    } else if (recurrence.freq === "monthly") {
      const curParts = getZonedParts(current, spec.timeZone)
      const targetParts = getZonedParts(targetMs, spec.timeZone)
      const curMonths = curParts.year * 12 + (curParts.month - 1)
      const targetMonths = targetParts.year * 12 + (targetParts.month - 1)
      const skip = Math.max(0, Math.floor((targetMonths - curMonths) / recurrence.interval) - 1)
      if (skip > 0) {
        if (recurrence.count != null && priorCount + skip >= recurrence.count) {
          return { occurrenceMs: null, priorCount: recurrence.count }
        }
        const jumpedTotalMonths = curMonths + skip * recurrence.interval
        const jumpedYear = Math.floor(jumpedTotalMonths / 12)
        const jumpedMonth = (jumpedTotalMonths % 12) + 1
        const jumpedDay = Math.min(anchor.day, daysInMonth(jumpedYear, jumpedMonth))
        current = zonedDateTimeToUtcMs(
          { year: jumpedYear, month: jumpedMonth, day: jumpedDay, hour: anchor.hour, minute: anchor.minute, second: anchor.second },
          spec.timeZone,
        )
        priorCount += skip
      }
    }
  }

  const untilMs = untilLimitMs(recurrence)
  if (untilMs !== null && current > untilMs) {
    return { occurrenceMs: null, priorCount }
  }

  let guard = 0
  while (current < targetMs && guard < 10_000) {
    guard += 1
    priorCount += 1
    const next = computeNextOccurrenceAfter(spec, current, priorCount)
    if (next === null) return { occurrenceMs: null, priorCount }
    current = next
  }

  if (current < targetMs) return { occurrenceMs: null, priorCount }
  return { occurrenceMs: current, priorCount }
}

export function computeInitialNextRun(
  spec: ScheduleSpec,
  nowMs: number,
): { nextRunAtMs: number | null; occurrenceCount: number } {
  const first = computeFirstOccurrenceMs(spec)
  if (first === null) return { nextRunAtMs: null, occurrenceCount: 0 }
  if (!spec.recurrence || first >= nowMs - 60_000) {
    return { nextRunAtMs: first, occurrenceCount: 0 }
  }
  return advanceNextRunAfterFire(spec, first, 1, nowMs)
}

export interface ExpandScheduleEventInput {
  id: string
  startAtMs: number
  durationMinutes: number
  timeZone: string
  recurrence: ScheduleRecurrence | null
}

export function expandScheduleOccurrences(
  event: ExpandScheduleEventInput,
  rangeStartMs: number,
  rangeEndMs: number,
  runStatusByScheduledMs: ReadonlyMap<number, ScheduleRunStatus> = new Map(),
): ScheduleOccurrence[] {
  const results: ScheduleOccurrence[] = []
  const seenMs = new Set<number>()
  const durationMs = event.durationMinutes * 60_000

  const addOccurrence = (startMs: number, status: ScheduleOccurrenceStatus) => {
    if (seenMs.has(startMs)) return
    seenMs.add(startMs)
    const startAt = new Date(startMs).toISOString()
    results.push({
      eventId: event.id,
      occurrenceKey: `${event.id}:${startAt}`,
      startAt,
      endAt: new Date(startMs + durationMs).toISOString(),
      runStatus: status,
    })
  }

  for (const [scheduledMs, status] of runStatusByScheduledMs.entries()) {
    if (scheduledMs + durationMs > rangeStartMs && scheduledMs < rangeEndMs) {
      addOccurrence(scheduledMs, status)
    }
  }

  const first = computeFirstOccurrenceMs(event)
  if (first !== null) {
    const lookbackStart = rangeStartMs - durationMs
    const start = fastForwardToOrAfter(event, first, 0, lookbackStart)
    let current = start.occurrenceMs
    let priorCount = start.priorCount
    let generated = 0
    while (current !== null && current < rangeEndMs && generated < SCHEDULE_MAX_OCCURRENCES_PER_EVENT) {
      if (current + durationMs > rangeStartMs) {
        addOccurrence(current, runStatusByScheduledMs.get(current) ?? "scheduled")
        generated += 1
      }
      priorCount += 1
      current = computeNextOccurrenceAfter(event, current, priorCount)
    }
  }

  results.sort((a, b) => a.startAt.localeCompare(b.startAt))
  return results
}
