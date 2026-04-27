export interface MeetingInfo {
  title: string
  meetingUrl: string | null
  startTime: string | null
  endTime: string | null
  attendees: { name: string; email: string }[]
}

const MEET_URL_RE = /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/gi
const ZOOM_URL_RE = /https:\/\/[\w.-]*zoom\.us\/j\/\d+[^\s<>"]*/gi
const TEAMS_URL_RE = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"]*/gi

function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "")
}

function extractProperty(lines: string[], prop: string): string | null {
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper.startsWith(prop.toUpperCase() + ":") || upper.startsWith(prop.toUpperCase() + ";")) {
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) continue
      return line.slice(colonIdx + 1).trim()
    }
  }
  return null
}

function parseIcsDate(value: string): string | null {
  if (!value) return null

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/)
  if (!match) return null

  const [, y, m, d, hh, mm, ss] = match
  const isUtc = value.endsWith("Z")

  if (isUtc) {
    return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`
  }
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`
}

function extractMeetingUrl(text: string): string | null {
  const meetMatch = text.match(MEET_URL_RE)
  if (meetMatch) return meetMatch[0]

  const zoomMatch = text.match(ZOOM_URL_RE)
  if (zoomMatch) return zoomMatch[0]

  const teamsMatch = text.match(TEAMS_URL_RE)
  if (teamsMatch) return teamsMatch[0]

  return null
}

function extractAttendees(lines: string[]): { name: string; email: string }[] {
  const attendees: { name: string; email: string }[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    if (!line.toUpperCase().startsWith("ATTENDEE")) continue

    let email = ""
    const mailtoMatch = line.match(/mailto:([^\s;>"]+)/i)
    if (mailtoMatch) {
      email = mailtoMatch[1].toLowerCase()
    }
    if (!email || seen.has(email)) continue
    seen.add(email)

    let name = ""
    const cnMatch = line.match(/CN=([^;:]+)/i)
    if (cnMatch) {
      name = cnMatch[1].replace(/^["']|["']$/g, "").trim()
    }

    attendees.push({ name: name || email, email })
  }

  return attendees
}

export function parseIcs(icsText: string): MeetingInfo {
  const unfolded = unfold(icsText)
  const lines = unfolded.split(/\r?\n/)

  const title = extractProperty(lines, "SUMMARY") ?? ""
  const dtStart = extractProperty(lines, "DTSTART")
  const dtEnd = extractProperty(lines, "DTEND")
  const location = extractProperty(lines, "LOCATION") ?? ""
  const description = extractProperty(lines, "DESCRIPTION") ?? ""

  const fullText = [location, description, title].join(" ")
  const meetingUrl = extractMeetingUrl(fullText)

  const startTime = dtStart ? parseIcsDate(dtStart) : null
  const endTime = dtEnd ? parseIcsDate(dtEnd) : null

  const attendees = extractAttendees(lines)

  return { title, meetingUrl, startTime, endTime, attendees }
}
