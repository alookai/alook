import { describe, it, expect } from "vitest"
import { parseIcs } from "./ics-parser"

const GOOGLE_MEET_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260428T140000Z
DTEND:20260428T150000Z
SUMMARY:Weekly Standup
LOCATION:https://meet.google.com/abc-defg-hij
ATTENDEE;CN=Alice Smith;RSVP=TRUE:mailto:alice@example.com
ATTENDEE;CN=Bob Jones;RSVP=TRUE:mailto:bob@example.com
DESCRIPTION:Weekly team sync meeting
END:VEVENT
END:VCALENDAR`

const ZOOM_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260429T100000Z
DTEND:20260429T110000Z
SUMMARY:Design Review
DESCRIPTION:Join Zoom Meeting\\nhttps://us02web.zoom.us/j/1234567890?pwd=abc
ATTENDEE;CN=Charlie;RSVP=TRUE:mailto:charlie@example.com
END:VEVENT
END:VCALENDAR`

const NO_MEETING_URL_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260430T090000Z
DTEND:20260430T093000Z
SUMMARY:Coffee Chat
DESCRIPTION:Just a casual chat
END:VEVENT
END:VCALENDAR`

const LOCAL_TIME_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART;TZID=America/New_York:20260428T100000
DTEND;TZID=America/New_York:20260428T110000
SUMMARY:Local Time Meeting
LOCATION:https://meet.google.com/xyz-wxyz-abc
END:VEVENT
END:VCALENDAR`


const NEW_YORK_ZONE = `BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
DTSTART:20070311T020000
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:20061105T020000
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`

const ANCIENT_MONTHLY_ZONE = `BEGIN:VTIMEZONE
TZID:Ancient/Monthly
BEGIN:DAYLIGHT
DTSTART:10000101T000000
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
RRULE:FREQ=MONTHLY;BYMONTHDAY=1
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:10000115T000000
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
RRULE:FREQ=MONTHLY;BYMONTHDAY=15
END:STANDARD
END:VTIMEZONE`

const RFC_TIME_VECTORS = [
  ["summer", "20260428T100000", "2026-04-28T14:00:00.000Z"],
  ["winter", "20260128T100000", "2026-01-28T15:00:00.000Z"],
  ["RFC overlap first occurrence", "20071104T013000", "2007-11-04T05:30:00.000Z"],
  ["RFC gap pre-transition offset", "20070311T023000", "2007-03-11T07:30:00.000Z"],
  ["before spring transition", "20070311T013000", "2007-03-11T06:30:00.000Z"],
  ["after spring transition", "20070311T033000", "2007-03-11T07:30:00.000Z"],
  ["before autumn transition", "20071104T003000", "2007-11-04T04:30:00.000Z"],
  ["after autumn transition", "20071104T023000", "2007-11-04T07:30:00.000Z"],
] as const

function timeInvitation(start: string, zone = "", end = ""): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", zone, "BEGIN:VEVENT", start, end,
    "SUMMARY:Qualification", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\n")
}

function fixedZone(offset: string): string {
  return ["BEGIN:VTIMEZONE", "TZID:Office", "BEGIN:STANDARD", "DTSTART:20000101T000000",
    `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, "END:STANDARD", "END:VTIMEZONE"].join("\n")
}

describe("ics-parser", () => {
  describe("parseIcs", () => {
    it("parses standard Google Calendar ICS with Google Meet link", () => {
      const result = parseIcs(GOOGLE_MEET_ICS)

      expect(result.title).toBe("Weekly Standup")
      expect(result.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
      expect(result.startTime).toBe("2026-04-28T14:00:00.000Z")
      expect(result.endTime).toBe("2026-04-28T15:00:00.000Z")
    })

    it("parses ICS with Zoom link in description", () => {
      const result = parseIcs(ZOOM_ICS)

      expect(result.title).toBe("Design Review")
      expect(result.meetingUrl).toBe("https://us02web.zoom.us/j/1234567890?pwd=abc")
    })

    it("extracts multiple attendees with names and emails", () => {
      const result = parseIcs(GOOGLE_MEET_ICS)

      expect(result.attendees).toHaveLength(2)
      expect(result.attendees[0]).toEqual({ name: "Alice Smith", email: "alice@example.com" })
      expect(result.attendees[1]).toEqual({ name: "Bob Jones", email: "bob@example.com" })
    })

    it("handles ICS with no meeting URL gracefully", () => {
      const result = parseIcs(NO_MEETING_URL_ICS)

      expect(result.title).toBe("Coffee Chat")
      expect(result.meetingUrl).toBeNull()
      expect(result.startTime).toBe("2026-04-30T09:00:00.000Z")
      expect(result.endTime).toBe("2026-04-30T09:30:00.000Z")
    })

    it("handles multi-line folded ICS fields (RFC 5545 unfold)", () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "DTSTART:20260428T140000Z",
        "DTEND:20260428T150000Z",
        "SUMMARY:Very Long Meeting Title That Gets Folded Across ",
        " Multiple Lines In The ICS Format",
        "LOCATION:https://meet.google.com/abc-defg-hij",
        "ATTENDEE;CN=\"Dr. Jane Doe\";RSVP=TRUE:mailto:jane@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n")

      const result = parseIcs(ics)

      expect(result.title).toBe("Very Long Meeting Title That Gets Folded Across Multiple Lines In The ICS Format")
      expect(result.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
    })

    it.each([
      ...RFC_TIME_VECTORS.map(([name, input, expected]) => ({
        name, ics: timeInvitation(`DTSTART;TZID=America/New_York:${input}`, NEW_YORK_ZONE),
        start: expected, end: null,
      })),
      { name: "exhausted ancient monthly recurrence", ics: timeInvitation("DTSTART;TZID=Ancient/Monthly:20260610T100000", ANCIENT_MONTHLY_ZONE), start: null, end: null },
      { name: "modern monthly rule with UTC UNTIL", ics: timeInvitation("DTSTART;TZID=Ancient/Monthly:20260610T100000", ANCIENT_MONTHLY_ZONE.replaceAll("1000", "2020").replaceAll("BYMONTHDAY=1\n", "BYMONTHDAY=1;UNTIL=20301231T230000Z\n").replaceAll("BYMONTHDAY=15\n", "BYMONTHDAY=15;UNTIL=20301231T230000Z\n")), start: "2026-06-10T09:00:00.000Z", end: null },
      { name: "original UTC UNTIL still limits conversion", ics: timeInvitation("DTSTART;TZID=Ancient/Monthly:20260610T100000", ANCIENT_MONTHLY_ZONE.replaceAll("1000", "2020").replaceAll("BYMONTHDAY=1\n", "BYMONTHDAY=1;UNTIL=20251231T230000Z\n").replaceAll("BYMONTHDAY=15\n", "BYMONTHDAY=15;UNTIL=20251231T230000Z\n")), start: "2026-06-10T10:00:00.000Z", end: null },
      { name: "original COUNT still limits conversion", ics: timeInvitation("DTSTART;TZID=Ancient/Monthly:20260610T100000", ANCIENT_MONTHLY_ZONE.replaceAll("1000", "2020").replaceAll("BYMONTHDAY=1\n", "BYMONTHDAY=1;COUNT=2\n").replaceAll("BYMONTHDAY=15\n", "BYMONTHDAY=15;COUNT=2\n")), start: "2026-06-10T10:00:00.000Z", end: null },
      { name: "all observances must finish", ics: timeInvitation("DTSTART;TZID=America/New_York:20260428T100000", NEW_YORK_ZONE.replace("END:VTIMEZONE", `${ANCIENT_MONTHLY_ZONE.split("\n").slice(2, -1).join("\n")}\nEND:VTIMEZONE`)), start: null, end: null },
      { name: "complete lookahead before conversion", ics: timeInvitation("DTSTART;TZID=Office:20260610T100000", fixedZone("+0100").replace("DTSTART:20000101T000000", "DTSTART:20210101T000000").replace("END:STANDARD", `RRULE:FREQ=MONTHLY;BYMONTHDAY=${Array.from({ length: 28 }, (_, i) => i + 1).join(",")};BYHOUR=0,12\nEND:STANDARD`)), start: null, end: null },
      { name: "finite local RDATE values", ics: timeInvitation("DTSTART;TZID=Ancient/Monthly:20260610T100000", ANCIENT_MONTHLY_ZONE.replaceAll("1000", "2020").replace("RRULE:FREQ=MONTHLY;BYMONTHDAY=1", "RDATE:20260601T000000,20260701T000000").replace("RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "RDATE:20260615T000000,20260715T000000")), start: "2026-06-10T09:00:00.000Z", end: null },
      { name: "UTC RDATE is not a local observance", ics: timeInvitation("DTSTART;TZID=Office:20260428T100000", fixedZone("+0100").replace("END:STANDARD", "RDATE:20260401T000000Z\nEND:STANDARD")), start: null, end: null },
      { name: "original bare IANA timezone", ics: LOCAL_TIME_ICS, start: null, end: null },
      { name: "original invitation with embedded definition", ics: LOCAL_TIME_ICS.replace("VERSION:2.0", `VERSION:2.0\n${NEW_YORK_ZONE}`), start: "2026-04-28T14:00:00.000Z", end: "2026-04-28T15:00:00.000Z" },
      { name: "unknown TZID", ics: timeInvitation("DTSTART;TZID=Unknown/Zone:20260428T100000", NEW_YORK_ZONE), start: null, end: null },
      { name: "floating", ics: timeInvitation("DTSTART:20260428T100000"), start: null, end: null },
      { name: "date only", ics: timeInvitation("DTSTART;VALUE=DATE:20260428"), start: null, end: null },
      { name: "invalid calendar date", ics: timeInvitation("DTSTART:20260230T100000Z"), start: null, end: null },
      { name: "invalid hour", ics: timeInvitation("DTSTART:20260428T250000Z"), start: null, end: null },
      { name: "missing timezone offsets", ics: timeInvitation("DTSTART;TZID=Office:20260428T100000", "BEGIN:VTIMEZONE\nTZID:Office\nBEGIN:STANDARD\nDTSTART:20000101T000000\nEND:STANDARD\nEND:VTIMEZONE"), start: null, end: null },
      { name: "unsupported second offset", ics: timeInvitation("DTSTART;TZID=Office:20260428T100000", fixedZone("+010030")), start: null, end: null },
      { name: "duplicate timezone definitions", ics: timeInvitation("DTSTART;TZID=Office:20260428T100000", `${fixedZone("+0100")}\n${fixedZone("+0200")}`), start: null, end: null },
      { name: "unsupported observance recurrence", ics: timeInvitation("DTSTART;TZID=Office:20260428T100000", fixedZone("+0100").replace("END:STANDARD", "RRULE:FREQ=DAILY\nEND:STANDARD")), start: null, end: null },
      { name: "known start with unknown end", ics: timeInvitation("DTSTART:20260428T140000Z", "", "DTEND:20260428T150000"), start: "2026-04-28T14:00:00.000Z", end: null },
      { name: "unknown start with known end", ics: timeInvitation("DTSTART:20260428T140000", "", "DTEND:20260428T150000Z"), start: null, end: "2026-04-28T15:00:00.000Z" },
    ])("resolves only absolute invitation times: $name", ({ ics, start, end }) => {
      const result = parseIcs(ics)
      expect(result.startTime).toBe(start)
      expect(result.endTime).toBe(end)
    })

    it("isolates same-named timezone definitions between invitations", () => {
      for (const [offset, expected] of [
        ["+0100", "2026-04-28T09:00:00.000Z"],
        ["+0200", "2026-04-28T08:00:00.000Z"],
        ["+0100", "2026-04-28T09:00:00.000Z"],
      ] as const) {
        expect(parseIcs(timeInvitation("DTSTART;TZID=Office:20260428T100000", fixedZone(offset))).startTime).toBe(expected)
      }
    })

    it("keeps all meeting fields inside the first VEVENT", () => {
      const second = ["BEGIN:VEVENT", "SUMMARY:Second meeting", "DTSTART:20260428T140000Z",
        "LOCATION:https://meet.google.com/abc-defg-hij", "ATTENDEE;CN=Other:mailto:other@example.test", "END:VEVENT"].join("\n")
      const first = NO_MEETING_URL_ICS.replace("END:VCALENDAR", `${second}\nEND:VCALENDAR`)
      expect(parseIcs(first)).toEqual({
        title: "Coffee Chat", meetingUrl: null,
        startTime: "2026-04-30T09:00:00.000Z", endTime: "2026-04-30T09:30:00.000Z", attendees: [],
      })
    })

    it("handles quoted CN names in attendees", () => {
      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Test",
        "ATTENDEE;CN=\"Dr. Jane Doe\";RSVP=TRUE:mailto:jane@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n")

      const result = parseIcs(ics)

      expect(result.attendees).toHaveLength(1)
      expect(result.attendees[0]).toEqual({ name: "Dr. Jane Doe", email: "jane@example.com" })
    })

    it("deduplicates attendees with same email", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260428T140000Z
DTEND:20260428T150000Z
SUMMARY:Test
ATTENDEE;CN=Alice:mailto:alice@example.com
ATTENDEE;CN=Alice Smith:mailto:alice@example.com
END:VEVENT
END:VCALENDAR`

      const result = parseIcs(ics)
      expect(result.attendees).toHaveLength(1)
      expect(result.attendees[0].email).toBe("alice@example.com")
    })

    it("returns empty attendees when none present", () => {
      const result = parseIcs(NO_MEETING_URL_ICS)
      expect(result.attendees).toEqual([])
    })

    it("uses email as name when CN is not provided", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260428T140000Z
SUMMARY:Test
ATTENDEE;RSVP=TRUE:mailto:noname@example.com
END:VEVENT
END:VCALENDAR`

      const result = parseIcs(ics)
      expect(result.attendees).toHaveLength(1)
      expect(result.attendees[0]).toEqual({ name: "noname@example.com", email: "noname@example.com" })
    })

    it("handles empty ICS gracefully", () => {
      const result = parseIcs("")
      expect(result.title).toBe("")
      expect(result.meetingUrl).toBeNull()
      expect(result.startTime).toBeNull()
      expect(result.endTime).toBeNull()
      expect(result.attendees).toEqual([])
    })

    it("prefers Google Meet URL over Zoom when both present", () => {
      const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Multi-platform
LOCATION:https://meet.google.com/abc-defg-hij
DESCRIPTION:Also join at https://us02web.zoom.us/j/123
END:VEVENT
END:VCALENDAR`

      const result = parseIcs(ics)
      expect(result.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
    })
  })
})
