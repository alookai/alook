import { describe, it, expect } from "vitest"
import * as meetingQueries from "../../src/db/queries/meeting-session"

describe("meeting-session query module exports", () => {
  it("exports createMeetingSession", () => {
    expect(typeof meetingQueries.createMeetingSession).toBe("function")
  })

  it("exports getMeetingSession", () => {
    expect(typeof meetingQueries.getMeetingSession).toBe("function")
  })

  it("exports getMeetingSessionById", () => {
    expect(typeof meetingQueries.getMeetingSessionById).toBe("function")
  })

  it("exports listMeetingSessions", () => {
    expect(typeof meetingQueries.listMeetingSessions).toBe("function")
  })

  it("exports updateMeetingSession", () => {
    expect(typeof meetingQueries.updateMeetingSession).toBe("function")
  })

  it("exports deleteMeetingSession", () => {
    expect(typeof meetingQueries.deleteMeetingSession).toBe("function")
  })

  it("exports listScheduledMeetings", () => {
    expect(typeof meetingQueries.listScheduledMeetings).toBe("function")
  })

  it("exports listMeetingsWithSchedule", () => {
    expect(typeof meetingQueries.listMeetingsWithSchedule).toBe("function")
  })
})

describe("meeting-session query function signatures", () => {
  it("listScheduledMeetings accepts (db, workspaceId, beforeOrAt)", () => {
    expect(meetingQueries.listScheduledMeetings.length).toBe(3)
  })

  it("createMeetingSession accepts (db, data)", () => {
    expect(meetingQueries.createMeetingSession.length).toBe(2)
  })

  it("getMeetingSession accepts (db, id, workspaceId)", () => {
    expect(meetingQueries.getMeetingSession.length).toBe(3)
  })

  it("updateMeetingSession accepts (db, id, workspaceId, patch)", () => {
    expect(meetingQueries.updateMeetingSession.length).toBe(4)
  })

  it("deleteMeetingSession accepts (db, id, workspaceId)", () => {
    expect(meetingQueries.deleteMeetingSession.length).toBe(3)
  })
})
