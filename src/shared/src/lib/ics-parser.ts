import ICAL from "ical.js"
import { resolveZone } from "@philflow/tsdav-utils"
import { z } from "zod"
import { MeetingInfoSchema } from "../schemas"

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
const IcsDateTimeSchema = z.iso.datetime({ local: true })
const IcsOffsetSchema = z.string().regex(/^[+-](?:[01]\d|2[0-3]):[0-5]\d$/)
  .refine(value => value !== "-00:00")

function hasSupportedObservances(zone: ICAL.Component, targetYear: number): boolean {
  // The pinned converter looks ahead 3660 days from its UTC probes (within
  // three days of this wall time). January of targetYear + 12 covers all of it.
  const throughYear = targetYear + 12
  if (throughYear > 9999) return false
  let remainingOnsets = 4096
  const onsetTimes: number[] = []
  const observances = [
    ...zone.getAllSubcomponents("standard"),
    ...zone.getAllSubcomponents("daylight"),
  ]
  const complete = observances.length > 0 && observances.every(observance => {
    const start = observance.getFirstProperty("dtstart")
    const value: unknown = start?.toJSON()[3]
    if (start?.type !== "date-time" || start.getParameter("tzid") !== undefined || typeof value !== "string"
      || value.endsWith("Z") || !IcsDateTimeSchema.safeParse(value).success
      || ["dtstart", "tzoffsetfrom", "tzoffsetto"].some(name => observance.getAllProperties(name).length !== 1)
      || !["tzoffsetfrom", "tzoffsetto"].every(name =>
        IcsOffsetSchema.safeParse(observance.getFirstProperty(name)?.toJSON()[3]).success)
      || --remainingOnsets < 0) return false

    const onsets = new Set<number>()
    const addOnset = (date: string) => {
      if (date.endsWith("Z") || !IcsDateTimeSchema.safeParse(date).success) return false
      const coordinate = Date.parse(`${date}Z`)
      if (!Number.isFinite(coordinate)) return false
      onsets.add(coordinate)
      return true
    }
    if (!addOnset(value)) return false

    for (const property of observance.getAllProperties("rdate")) {
      if (property.type !== "date-time" || property.getParameter("tzid") !== undefined) return false
      for (const date of property.toJSON().slice(3)) {
        if (typeof date !== "string" || date.endsWith("Z")
          || !IcsDateTimeSchema.safeParse(date).success || --remainingOnsets < 0) return false
        if (!addOnset(date)) return false
      }
    }
    for (const property of observance.getAllProperties("rrule")) {
      const rule = (property.getFirstValue() as ICAL.Recur).clone()
      if (!["YEARLY", "MONTHLY"].includes(rule.freq)
        || !Number.isInteger(rule.interval) || rule.interval < 1) return false
      // A superset avoids undercounting when the converter adjusts UTC UNTIL.
      // Only this admission clone changes; conversion receives the original.
      rule.until = null
      rule.count = null
      const iterator = rule.iterator(start.getFirstValue() as ICAL.Time)
      for (;;) {
        if (--remainingOnsets < 0) return false
        const next = iterator.next()
        if (!next) break
        if (!addOnset(next.toString())) return false
        if (next.year >= throughYear) break
      }
    }
    onsetTimes.push(...onsets)
    return true
  })
  if (!complete) return false
  // Offsets below 24 hours make seven wall-clock days exceed five UTC days.
  // This bounds adjacent transitions away from the converter's ±2-day probes.
  onsetTimes.sort((a, b) => a - b)
  return onsetTimes.every((time, index) => index === 0 || time - onsetTimes[index - 1]! >= 7 * 24 * 60 * 60 * 1000)
}

function parseIcsDate(event: ICAL.Component, calendar: ICAL.Component, name: string): string | null {
  try {
    const property = event.getFirstProperty(name)
    const value: unknown = property?.toJSON()[3]
    if (property?.type !== "date-time" || typeof value !== "string"
      || !IcsDateTimeSchema.safeParse(value).success) return null

    const tzid = property.getParameter("tzid")
    if (value.endsWith("Z")) {
      return tzid === undefined ? MeetingInfoSchema.shape.startTime.parse(value) : null
    }
    if (typeof tzid !== "string" || !tzid) return null
    const zones = calendar.getAllSubcomponents("vtimezone")
      .filter(zone => zone.getFirstPropertyValue("tzid") === tzid)
    const zone = zones[0]
    if (zones.length !== 1 || !zone || !hasSupportedObservances(zone, Number(value.slice(0, 4)))) return null
    const converter = resolveZone(tzid, zone)
    if (converter?.source !== "vtimezone") return null
    return MeetingInfoSchema.shape.startTime.parse(converter.toInstant(value).toISOString())
  } catch {
    return null
  }
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

function extractAttendees(event: ICAL.Component): { name: string; email: string }[] {
  const attendees: { name: string; email: string }[] = []
  const seen = new Set<string>()
  for (const property of event.getAllProperties("attendee")) {
    const value = property.getFirstValue()
    const match = typeof value === "string" ? value.match(/^mailto:([^\s;>"]+)$/i) : null
    if (!match) continue
    const email = match[1].toLowerCase()
    if (seen.has(email)) continue
    seen.add(email)
    const cn = property.getParameter("cn")
    attendees.push({ name: typeof cn === "string" && cn.trim() ? cn.trim() : email, email })
  }
  return attendees
}

export function parseIcs(icsText: string): MeetingInfo {
  const result: MeetingInfo = { title: "", meetingUrl: null, startTime: null, endTime: null, attendees: [] }
  try {
    const calendar = new ICAL.Component(ICAL.parse(icsText))
    const event = calendar.name === "vevent" ? calendar : calendar.getFirstSubcomponent("vevent")
    if (!event) return result
    const title = event.getFirstPropertyValue("summary")
    result.title = typeof title === "string" ? title : ""
    const fullText = [event.getFirstPropertyValue("location"), event.getFirstPropertyValue("description"), result.title]
      .filter((value): value is string => typeof value === "string").join(" ")
    result.meetingUrl = extractMeetingUrl(fullText)
    result.startTime = parseIcsDate(event, calendar, "dtstart")
    result.endTime = parseIcsDate(event, calendar, "dtend")
    result.attendees = extractAttendees(event)
  } catch {
    return result
  }
  return result
}
