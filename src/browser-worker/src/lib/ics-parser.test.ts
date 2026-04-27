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

describe("ics-parser", () => {
  describe("parseIcs", () => {
    it("parses standard Google Calendar ICS with Google Meet link", () => {
      const result = parseIcs(GOOGLE_MEET_ICS)

      expect(result.title).toBe("Weekly Standup")
      expect(result.meetingUrl).toBe("https://meet.google.com/abc-defg-hij")
      expect(result.startTime).toBe("2026-04-28T14:00:00Z")
      expect(result.endTime).toBe("2026-04-28T15:00:00Z")
    })

    it("parses ICS with Zoom link in description", () => {
      const result = parseIcs(ZOOM_ICS)

      expect(result.title).toBe("Design Review")
      expect(result.meetingUrl).toContain("zoom.us/j/1234567890")
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
      expect(result.startTime).toBe("2026-04-30T09:00:00Z")
      expect(result.endTime).toBe("2026-04-30T09:30:00Z")
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

    it("extracts DTSTART/DTEND with timezone (non-UTC)", () => {
      const result = parseIcs(LOCAL_TIME_ICS)

      expect(result.startTime).toBe("2026-04-28T10:00:00")
      expect(result.endTime).toBe("2026-04-28T11:00:00")
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
