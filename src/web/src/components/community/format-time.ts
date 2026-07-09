// Time formatting for community message timestamps.
// Accepts ISO 8601 strings and formats for display.

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const DATE_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
const FULL_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })

function isToday(d: Date) {
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

function isYesterday(d: Date) {
  const y = new Date()
  y.setDate(y.getDate() - 1)
  return d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()
}

// Format a message timestamp for inline display: "9:31 PM" (today), "Yesterday 9:31 PM", or "Jun 11, 2026 9:31 PM"
export function formatMessageTime(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (isToday(d)) return TIME_FMT.format(d)
  if (isYesterday(d)) return `Yesterday ${TIME_FMT.format(d)}`
  return FULL_FMT.format(d)
}

// Format a date label for the divider: "May 11, 2026", "Yesterday", "Today"
export function formatDateLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  if (isToday(d)) return "Today"
  if (isYesterday(d)) return "Yesterday"
  return DATE_FMT.format(d)
}

// Format relative time for thread/forum/inbox: "2m ago", "3h ago", "Jun 11"
export function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffMs = Date.now() - d.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return DATE_FMT.format(d)
}

// Get just the date key (YYYY-MM-DD) from an ISO string for grouping
export function dateKey(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
