import { describe, it, expect, vi } from "vitest"
import * as meetingQueries from "../../src/db/queries/meeting-session"

function createMockDb(rows: any[]) {
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.from = vi.fn(() => chain)
  chain.where = vi.fn(() => Promise.resolve(rows))
  chain.orderBy = vi.fn(() => chain)
  chain.update = vi.fn(() => chain)
  chain.set = vi.fn(() => chain)
  chain.returning = vi.fn(() => Promise.resolve(rows))
  chain.delete = vi.fn(() => chain)
  chain.leftJoin = vi.fn(() => chain)
  return chain
}



describe("getMeetingSession", () => {
  it("returns null when meeting not found", async () => {
    const mockDb = createMockDb([])
    const result = await meetingQueries.getMeetingSession(mockDb, "ms_missing", "ws_1")
    expect(result).toBeNull()
  })

  it("returns meeting when found", async () => {
    const meeting = { id: "ms_1", title: "Standup", status: "scheduled" }
    const mockDb = createMockDb([meeting])
    const result = await meetingQueries.getMeetingSession(mockDb, "ms_1", "ws_1")
    expect(result).toEqual(meeting)
  })
})

describe("getMeetingSessionById", () => {
  it("returns null when meeting not found", async () => {
    const mockDb = createMockDb([])
    const result = await meetingQueries.getMeetingSessionById(mockDb, "ms_missing")
    expect(result).toBeNull()
  })
})

describe("updateMeetingSession", () => {
  it("returns null when no row updated", async () => {
    const chain: any = {}
    chain.update = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.returning = vi.fn(() => Promise.resolve([]))
    const result = await meetingQueries.updateMeetingSession(chain, "ms_1", "ws_1", { title: "New" })
    expect(result).toBeNull()
  })
})

describe("claimMeetingSession", () => {
  it("returns null when session not in scheduled state", async () => {
    const chain: any = {}
    chain.update = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.returning = vi.fn(() => Promise.resolve([]))
    const result = await meetingQueries.claimMeetingSession(chain, "ms_1", "ws_1", "2026-01-01T00:00:00Z")
    expect(result).toBeNull()
  })
})

describe("claimMeetingSessions", () => {
  it("returns empty array for empty ids", async () => {
    const result = await meetingQueries.claimMeetingSessions(null as any, [], "ws_1", "2026-01-01T00:00:00Z")
    expect(result).toEqual([])
  })
})

describe("deleteMeetingSession", () => {
  it("returns null when session not found", async () => {
    const chain: any = {}
    chain.delete = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.returning = vi.fn(() => Promise.resolve([]))
    const result = await meetingQueries.deleteMeetingSession(chain, "ms_missing", "ws_1")
    expect(result).toBeNull()
  })
})
