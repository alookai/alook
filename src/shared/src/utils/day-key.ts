/**
 * The single source of truth for the calendar-day key used by the bot activity
 * heatmap. Both rollup upserts (handled and sent, written from different code
 * paths) MUST derive "today" through this one helper: if they diverged on the
 * day boundary (e.g. UTC vs local time), the same calendar day's handled and
 * sent counts would land in different `(botId, day)` rows and the two series
 * would misalign, mis-coloring the single-cell total the UI renders.
 *
 * UTC `YYYY-MM-DD`. Accepts a `Date` or an ISO string (or ms epoch) so callers
 * can pass whatever "now" they already hold.
 */
export function utcDayKey(now: Date | string | number): string {
  const d = now instanceof Date ? now : new Date(now)
  return d.toISOString().slice(0, 10)
}

/**
 * The UTC `YYYY-MM-DD` key `days` calendar days before `now` (inclusive-window
 * lower bound). The heatmap read passes `utcDayKeyDaysAgo(now, 29)` so a 30-day
 * window (today + the 29 preceding days) is returned.
 */
export function utcDayKeyDaysAgo(now: Date | string | number, days: number): string {
  const d = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  d.setUTCDate(d.getUTCDate() - days)
  return utcDayKey(d)
}

export function calendarDayKeyDaysAgo(day: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new RangeError("invalid calendar day key")
  const year = Number(match[1])
  const month = Number(match[2])
  const date = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, date))
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== date
  ) {
    throw new RangeError("invalid calendar day key")
  }
  parsed.setUTCDate(parsed.getUTCDate() - days)
  return utcDayKey(parsed)
}

export function dayKeyInTimeZone(now: Date | string | number, timeZone: string): string {
  const date = now instanceof Date ? now : new Date(now)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const year = values.get("year")
  const month = values.get("month")
  const day = values.get("day")
  if (!year || !month || !day) throw new RangeError("unable to format calendar day key")
  return `${year}-${month}-${day}`
}
