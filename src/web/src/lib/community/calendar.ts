import { queryOptions } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { apiFetchCommunity } from "./account-cache-lifecycle"

export type CalendarViewMode = "week" | "agenda"

type CalendarActorKind = "human" | "bot"

export type CalendarActor = {
  id: string
  name: string
  handle?: string | null
  kind: CalendarActorKind
  avatarUrl?: string | null
}

export type CalendarSourceMessage = {
  messageId: string
  accessible: boolean
  status?: "accessible" | "inaccessible" | "deleted" | (string & {})
  channelLabel?: string | null
  excerpt?: string | null
  unavailableReason?: string | null
}

type CalendarRunStatus = "pending" | "dispatched" | "completed" | "blocked_access"

export type CalendarOccurrenceRunStatus = "scheduled" | CalendarRunStatus

type CalendarExecutionSummary = {
  status: CalendarRunStatus
  scheduledAt?: string | null
  updatedAt?: string | null
  ackedAt?: string | null
  lastError?: string | null
}

export type CalendarRecurrenceFreq = "hourly" | "daily" | "weekly" | "monthly"

export type CalendarRecurrenceRule = {
  freq: CalendarRecurrenceFreq
  interval: number
  byWeekday?: number[]
  untilAt?: string | null
  count?: number | null
}

export type CalendarRecurrenceSummary = {
  recurring: boolean
  label: string
  ruleText?: string | null
  rule?: CalendarRecurrenceRule | null
  nextRunAt?: string | null
}

export type CalendarEventItem = {
  id: string
  title: string
  description?: string | null
  creator: CalendarActor
  startAt: string
  durationMinutes: number
  endAt?: string | null
  timeZone: string
  recurrence: CalendarRecurrenceSummary
  sourceMessage: CalendarSourceMessage
  lastExecution?: CalendarExecutionSummary | null
}

export type CalendarOccurrenceItem = {
  occurrenceKey: string
  eventId: string
  startAt: string
  endAt?: string | null
  runStatus?: CalendarOccurrenceRunStatus | null
  event: CalendarEventItem
}

export type CalendarEventEditDraft = {
  title: string
  description: string
  startAt: string
  durationMinutes: number
  timeZone: string
  recurrence: CalendarRecurrenceRule | null
}

type CalendarActorDto = {
  id: string
  handle: string
  name: string
  avatarVersion: number
  isBot: boolean
}

type CalendarLastExecutionDto = {
  scheduledAt: string
  status: CalendarRunStatus
  lastError: string | null
  ackedAt?: string | null
  updatedAt: string
}

type CalendarSourceMessageDto = {
  id: string
  accessible: boolean
  status: "accessible" | "inaccessible" | "deleted"
  ref: string | null
  channelRef: string | null
  seq: number | null
  preview: string | null
}

export type CalendarEventDto = {
  id: string
  title: string
  description: string
  createdBy: CalendarActorDto
  startAt: string
  durationMinutes: number
  timeZone: string
  recurrence: CalendarRecurrenceRule | null
  nextRunAt: string | null
  sourceMessage: CalendarSourceMessageDto
  lastExecution: CalendarLastExecutionDto | null
  createdAt: string
  updatedAt: string
}

type CalendarOccurrenceDto = {
  eventId: string
  occurrenceKey: string
  startAt: string
  endAt: string
  runStatus: CalendarOccurrenceRunStatus
}

export type CalendarListResponseDto = {
  events: CalendarEventDto[]
  occurrences: CalendarOccurrenceDto[]
  creators: CalendarActorDto[]
}

export type CalendarUpdateRequestDto = {
  title?: string
  description?: string
  startAt?: string
  durationMinutes?: number
  timeZone?: string
  recurrence?: CalendarRecurrenceRule | null
  ack?: boolean
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export function formatCalendarRecurrence(recurrence: CalendarRecurrenceRule | null): {
  recurring: boolean
  label: string
  ruleText: string | null
} {
  if (!recurrence) {
    return { recurring: false, label: "One-time", ruleText: null }
  }
  const interval = Math.max(1, Math.floor(recurrence.interval || 1))
  let base: string
  switch (recurrence.freq) {
    case "hourly":
      base = interval === 1 ? "Hourly" : `Every ${interval} hours`
      break
    case "daily":
      base = interval === 1 ? "Daily" : `Every ${interval} days`
      break
    case "weekly": {
      const days = (recurrence.byWeekday ?? [])
        .filter((d) => d >= 0 && d <= 6)
        .map((d) => WEEKDAY_LABELS[d])
      const prefix = interval === 1 ? "Weekly" : `Every ${interval} weeks`
      base = days.length > 0 ? `${prefix} · ${days.join(", ")}` : prefix
      break
    }
    case "monthly":
      base = interval === 1 ? "Monthly" : `Every ${interval} months`
      break
  }

  const limits: string[] = []
  if (recurrence.untilAt) {
    const until = new Date(recurrence.untilAt)
    if (!Number.isNaN(until.getTime())) {
      limits.push(
        `until ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(until)}`,
      )
    }
  }
  if (recurrence.count && recurrence.count > 0) {
    limits.push(`${recurrence.count} ${recurrence.count === 1 ? "time" : "times"}`)
  }

  return {
    recurring: true,
    label: base,
    ruleText: limits.length > 0 ? limits.join(" · ") : null,
  }
}

function mapActor(
  dto: CalendarActorDto,
  avatarByUserId: ReadonlyMap<string, string | null>,
): CalendarActor {
  return {
    id: dto.id,
    name: dto.name,
    handle: dto.handle,
    kind: dto.isBot ? "bot" : "human",
    avatarUrl: avatarByUserId.get(dto.id) ?? null,
  }
}

function unavailableSourceReason(status: CalendarSourceMessageDto["status"]): string {
  if (status === "deleted") {
    return "The original message was deleted. Content is hidden and automatic replies cannot be posted."
  }
  return "Access to the original conversation was lost. Content is hidden and automatic replies cannot be posted."
}

function mapCalendarEventDto(
  dto: CalendarEventDto,
  avatarByUserId: ReadonlyMap<string, string | null> = new Map(),
): CalendarEventItem {
  const formatted = formatCalendarRecurrence(dto.recurrence)
  const endMs = Date.parse(dto.startAt) + dto.durationMinutes * 60_000
  const endAt = Number.isFinite(endMs) ? new Date(endMs).toISOString() : null
  const accessible = dto.sourceMessage.accessible

  return {
    id: dto.id,
    title: dto.title,
    description: dto.description || null,
    creator: mapActor(dto.createdBy, avatarByUserId),
    startAt: dto.startAt,
    durationMinutes: dto.durationMinutes,
    endAt,
    timeZone: dto.timeZone,
    recurrence: {
      ...formatted,
      rule: dto.recurrence,
      nextRunAt: dto.nextRunAt,
    },
    sourceMessage: {
      messageId: dto.sourceMessage.id,
      accessible,
      status: dto.sourceMessage.status,
      channelLabel: accessible ? (dto.sourceMessage.ref ?? dto.sourceMessage.channelRef) : null,
      excerpt: accessible ? dto.sourceMessage.preview : null,
      unavailableReason: accessible ? null : unavailableSourceReason(dto.sourceMessage.status),
    },
    lastExecution: dto.lastExecution
      ? {
          status: dto.lastExecution.status,
          scheduledAt: dto.lastExecution.scheduledAt,
          updatedAt: dto.lastExecution.updatedAt,
          ackedAt: dto.lastExecution.ackedAt ?? null,
          lastError: dto.lastExecution.lastError,
        }
      : null,
  }
}

export function mapCalendarListResponse(
  response: CalendarListResponseDto,
  avatarByUserId: ReadonlyMap<string, string | null> = new Map(),
): {
  events: CalendarEventItem[]
  occurrences: CalendarOccurrenceItem[]
  creators: CalendarActor[]
} {
  const events = response.events.map((dto) => mapCalendarEventDto(dto, avatarByUserId))
  const eventById = new Map(events.map((item) => [item.id, item]))
  const occurrences: CalendarOccurrenceItem[] = []
  for (const occ of response.occurrences) {
    const event = eventById.get(occ.eventId)
    if (!event) continue
    occurrences.push({
      occurrenceKey: occ.occurrenceKey,
      eventId: occ.eventId,
      startAt: occ.startAt,
      endAt: occ.endAt,
      runStatus: occ.runStatus,
      event,
    })
  }
  const creators = response.creators.map((actor) => mapActor(actor, avatarByUserId))
  return { events, occurrences, creators }
}

export function calendarEventsQueryOptions(params: {
  from: string
  to: string
}) {
  return queryOptions({
    queryKey: communityKeys.calendarEvents(params),
    queryFn: async ({ client, signal }): Promise<CalendarListResponseDto> => {
      const token = captureCommunityLiveSnapshotToken(client)
      const search = new URLSearchParams({
        from: params.from,
        to: params.to,
      })
      return apiFetchCommunity<CalendarListResponseDto>(
        `/api/community/calendar/events?${search.toString()}`,
        { signal },
        token,
      )
    },
  })
}
