import { queryOptions } from "@tanstack/react-query"
import type {
  ScheduleActorSummary,
  ScheduleEvent,
  ScheduleListResponse,
  ScheduleOccurrenceStatus,
  ScheduleRecurrence,
  ScheduleRunStatus,
  ScheduleSourceMessageStatus,
} from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { apiFetchCommunity } from "./account-cache-lifecycle"

export type ScheduleViewMode = "week" | "agenda"

type ScheduleActorKind = "human" | "bot"

export type ScheduleActor = {
  id: string
  name: string
  handle?: string | null
  kind: ScheduleActorKind
  avatarUrl?: string | null
}

export type ScheduleSourceMessage = {
  messageId: string
  accessible: boolean
  status?: ScheduleSourceMessageStatus | (string & {})
  channelLabel?: string | null
  excerpt?: string | null
  unavailableReason?: string | null
}

export type ScheduleOccurrenceRunStatus = ScheduleOccurrenceStatus

type ScheduleExecutionSummary = {
  status: ScheduleRunStatus
  scheduledAt?: string | null
  updatedAt?: string | null
  ackedAt?: string | null
  lastError?: string | null
}

type ScheduleRecurrenceRule = ScheduleRecurrence

export type ScheduleRecurrenceSummary = {
  recurring: boolean
  label: string
  ruleText?: string | null
  rule?: ScheduleRecurrenceRule | null
  nextRunAt?: string | null
}

export type ScheduleEventItem = {
  id: string
  title: string
  description?: string | null
  creator: ScheduleActor
  startAt: string
  durationMinutes: number
  endAt?: string | null
  timeZone: string
  recurrence: ScheduleRecurrenceSummary
  sourceMessage: ScheduleSourceMessage
  lastExecution?: ScheduleExecutionSummary | null
}

export type ScheduleOccurrenceItem = {
  occurrenceKey: string
  eventId: string
  startAt: string
  endAt?: string | null
  runStatus?: ScheduleOccurrenceRunStatus | null
  event: ScheduleEventItem
}

export type ScheduleListResponseDto = ScheduleListResponse

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export function formatScheduleRecurrence(recurrence: ScheduleRecurrenceRule | null): {
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
  dto: ScheduleActorSummary,
  avatarByUserId: ReadonlyMap<string, string | null>,
): ScheduleActor {
  return {
    id: dto.id,
    name: dto.name,
    handle: dto.handle,
    kind: dto.isBot ? "bot" : "human",
    avatarUrl: avatarByUserId.get(dto.id) ?? null,
  }
}

function unavailableSourceReason(status: ScheduleSourceMessageStatus): string {
  if (status === "deleted") {
    return "The original message was deleted. Content is hidden and automatic replies cannot be posted."
  }
  return "Access to the original conversation was lost. Content is hidden and automatic replies cannot be posted."
}

function mapScheduleEventDto(
  dto: ScheduleEvent,
  avatarByUserId: ReadonlyMap<string, string | null> = new Map(),
): ScheduleEventItem {
  const formatted = formatScheduleRecurrence(dto.recurrence)
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

export function mapScheduleListResponse(
  response: ScheduleListResponseDto,
  avatarByUserId: ReadonlyMap<string, string | null> = new Map(),
): {
  events: ScheduleEventItem[]
  occurrences: ScheduleOccurrenceItem[]
  creators: ScheduleActor[]
} {
  const events = response.events.map((dto) => mapScheduleEventDto(dto, avatarByUserId))
  const eventById = new Map(events.map((item) => [item.id, item]))
  const occurrences: ScheduleOccurrenceItem[] = []
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

export function scheduleEventsQueryOptions(params: {
  from: string
  to: string
}) {
  return queryOptions({
    queryKey: communityKeys.scheduleEvents(params),
    queryFn: async ({ client, signal }): Promise<ScheduleListResponseDto> => {
      const token = captureCommunityLiveSnapshotToken(client)
      const search = new URLSearchParams({
        from: params.from,
        to: params.to,
      })
      return apiFetchCommunity<ScheduleListResponseDto>(
        `/api/community/schedule/events?${search.toString()}`,
        { signal },
        token,
      )
    },
  })
}
