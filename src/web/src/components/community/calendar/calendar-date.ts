import type { CalendarOccurrenceItem } from "./calendar-types"

const DEFAULT_WEEK_STARTS_ON = 1
export const DEFAULT_OCCURRENCE_DURATION_MINUTES = 30
export const WEEK_HOUR_HEIGHT_PX = 60
export const WEEK_HOURS = Array.from({ length: 24 }, (_, hour) => hour)

export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

export function startOfWeek(date: Date, weekStartsOn: 0 | 1 = DEFAULT_WEEK_STARTS_ON): Date {
  const dayStart = startOfLocalDay(date)
  const diff = (dayStart.getDay() - weekStartsOn + 7) % 7
  return addLocalDays(dayStart, -diff)
}

export function getWeekDays(anchorDate: Date, weekStartsOn: 0 | 1 = DEFAULT_WEEK_STARTS_ON): Date[] {
  const weekStart = startOfWeek(anchorDate, weekStartsOn)
  return Array.from({ length: 7 }, (_, i) => addLocalDays(weekStart, i))
}

export function getWeekQueryRange(anchorDate: Date, weekStartsOn: 0 | 1 = DEFAULT_WEEK_STARTS_ON): {
  from: string
  to: string
} {
  const from = startOfWeek(anchorDate, weekStartsOn)
  const to = addLocalDays(from, 7)
  return {
    from: from.toISOString(),
    to: to.toISOString(),
  }
}

export function getAgendaQueryRange(anchorDate: Date, horizonDays = 30): {
  from: string
  to: string
} {
  const from = startOfLocalDay(anchorDate)
  const to = addLocalDays(from, horizonDays)
  return {
    from: from.toISOString(),
    to: to.toISOString(),
  }
}

export function localDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  )
}

export function formatWeekRangeLabel(days: readonly Date[]): string {
  if (days.length === 0) return ""
  const first = days[0]!
  const last = days[days.length - 1]!
  const sameYear = first.getFullYear() === last.getFullYear()
  const sameMonth = sameYear && first.getMonth() === last.getMonth()

  if (sameMonth) {
    const month = new Intl.DateTimeFormat(undefined, { month: "short" }).format(first)
    return `${month} ${first.getDate()} – ${last.getDate()}, ${last.getFullYear()}`
  }
  if (sameYear) {
    const startLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(first)
    const endLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(last)
    return `${startLabel} – ${endLabel}, ${last.getFullYear()}`
  }
  const full = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
  return `${full.format(first)} – ${full.format(last)}`
}

export function formatMonthHeadingParts(days: readonly Date[], anchorDate: Date): {
  month: string
  monthShort: string
  year: string
  rangeShort: string
} {
  const first = days[0] ?? anchorDate
  const last = days[days.length - 1] ?? anchorDate
  const sameYear = first.getFullYear() === last.getFullYear()
  const sameMonth = sameYear && first.getMonth() === last.getMonth()
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(anchorDate)
  const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" }).format(anchorDate)
  const year = String(anchorDate.getFullYear())
  const rangeShort = sameMonth
    ? `${new Intl.DateTimeFormat(undefined, { month: "short" }).format(first)} ${first.getDate()} – ${last.getDate()}`
    : `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(first)} – ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(last)}`
  return { month, monthShort, year, rangeShort }
}

export function formatWeekdayShort(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)
}

export function formatLocalTimeZoneShort(date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "shortOffset" }).formatToParts(date)
    const offset = parts.find((part) => part.type === "timeZoneName")?.value
    if (offset) return offset.replace("GMT", "UTC")
  } catch {
    // Fall back to resolved timezone tail below.
  }
  return "Local"
}

export function formatLocalTimeZoneFull(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Local"
}

export function formatMobileDayHeading(date: Date, now: Date): string {
  const heading = formatAgendaDayLabel(date, now)
  if (heading.isToday || heading.primary === "Tomorrow" || heading.primary === "Yesterday") {
    return `${heading.primary} · ${heading.secondary}`
  }
  return `${heading.primary}, ${heading.secondary}`
}

export function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`
}

function formatTimeShort(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

export function formatTimeRange(startIso: string, endIso?: string | null): string {
  const start = formatTimeShort(startIso)
  if (!start) return ""
  if (!endIso) return start
  const end = formatTimeShort(endIso)
  if (!end || end === start) return start
  return `${start} – ${end}`
}

export function formatAgendaDayLabel(date: Date, now: Date): {
  primary: string
  secondary: string
  isToday: boolean
} {
  const today = startOfLocalDay(now)
  const target = startOfLocalDay(date)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  const secondary = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(target)

  if (diffDays === 0) return { primary: "Today", secondary, isToday: true }
  if (diffDays === 1) return { primary: "Tomorrow", secondary, isToday: false }
  if (diffDays === -1) return { primary: "Yesterday", secondary, isToday: false }
  return {
    primary: new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(target),
    secondary: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: target.getFullYear() !== now.getFullYear() ? "numeric" : undefined }).format(target),
    isToday: false,
  }
}

export function formatTimeInputValue(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

export function combineLocalDateAndTime(date: Date, timeHHMM: string): Date {
  const [rawHour = "0", rawMinute = "0"] = timeHHMM.split(":")
  const hour = Math.min(23, Math.max(0, Number.parseInt(rawHour, 10) || 0))
  const minute = Math.min(59, Math.max(0, Number.parseInt(rawMinute, 10) || 0))
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0)
}

function minutesFromDayStart(iso: string, dayDate: Date): number {
  const date = new Date(iso)
  const start = startOfLocalDay(dayDate)
  return (date.getTime() - start.getTime()) / 60_000
}

export type PositionedDayBlock = {
  item: CalendarOccurrenceItem
  startMinutes: number
  endMinutes: number
  topPx: number
  heightPx: number
  column: number
  columnCount: number
}

export function layoutDayOccurrences(
  items: readonly CalendarOccurrenceItem[],
  dayDate: Date,
  hourHeightPx = WEEK_HOUR_HEIGHT_PX,
): PositionedDayBlock[] {
  const minMinutes = 24
  const entries = items
    .map((item) => {
      const rawStart = minutesFromDayStart(item.startAt, dayDate)
      const startMinutes = Math.max(0, Math.min(24 * 60 - minMinutes, rawStart))
      const rawEnd = item.endAt
        ? minutesFromDayStart(item.endAt, dayDate)
        : startMinutes + DEFAULT_OCCURRENCE_DURATION_MINUTES
      const endMinutes = Math.max(startMinutes + minMinutes, Math.min(24 * 60, rawEnd))
      return { item, startMinutes, endMinutes }
    })
    .sort((a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes)

  const clusters: Array<typeof entries> = []
  let currentCluster: typeof entries = []
  let clusterEnd = -1

  for (const entry of entries) {
    if (currentCluster.length === 0 || entry.startMinutes < clusterEnd) {
      currentCluster.push(entry)
      clusterEnd = Math.max(clusterEnd, entry.endMinutes)
    } else {
      clusters.push(currentCluster)
      currentCluster = [entry]
      clusterEnd = entry.endMinutes
    }
  }
  if (currentCluster.length > 0) clusters.push(currentCluster)

  const positioned: PositionedDayBlock[] = []
  for (const cluster of clusters) {
    const columnEnds: number[] = []
    const assigned: Array<{ entry: (typeof entries)[number]; column: number }> = []
    for (const entry of cluster) {
      let col = columnEnds.findIndex((end) => end <= entry.startMinutes)
      if (col === -1) {
        col = columnEnds.length
        columnEnds.push(entry.endMinutes)
      } else {
        columnEnds[col] = entry.endMinutes
      }
      assigned.push({ entry, column: col })
    }
    const columnCount = Math.max(1, columnEnds.length)
    for (const { entry, column } of assigned) {
      positioned.push({
        item: entry.item,
        startMinutes: entry.startMinutes,
        endMinutes: entry.endMinutes,
        topPx: (entry.startMinutes / 60) * hourHeightPx,
        heightPx: Math.max(26, ((entry.endMinutes - entry.startMinutes) / 60) * hourHeightPx),
        column,
        columnCount,
      })
    }
  }

  return positioned
}

export function groupOccurrencesByDay(
  items: readonly CalendarOccurrenceItem[],
): Array<{ dayKey: string; date: Date; items: CalendarOccurrenceItem[] }> {
  const sorted = [...items].sort(
    (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
  )
  const map = new Map<string, { dayKey: string; date: Date; items: CalendarOccurrenceItem[] }>()
  for (const item of sorted) {
    const d = new Date(item.startAt)
    if (Number.isNaN(d.getTime())) continue
    const key = localDayKey(d)
    let group = map.get(key)
    if (!group) {
      group = { dayKey: key, date: startOfLocalDay(d), items: [] }
      map.set(key, group)
    }
    group.items.push(item)
  }
  return Array.from(map.values())
}
