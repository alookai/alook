import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { parseIcs } from "@alook/shared"

const mocks = vi.hoisted(() => ({
  agent: vi.fn(), email: vi.fn(), meeting: vi.fn(), broadcast: vi.fn(), invalidate: vi.fn(),
  conversation: vi.fn(), task: vi.fn(),
}))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@alook/shared")>(),
  queries: {
    agent: { getAgent: mocks.agent },
    email: { createEmail: mocks.email },
    meetingSession: { createMeetingSession: mocks.meeting },
    conversation: { createConversation: mocks.conversation },
    task: { createTask: mocks.task },
  },
}))
vi.mock("@/lib/broadcast", () => ({ broadcastToUser: mocks.broadcast }))
vi.mock("@/lib/cache", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/cache")>(), invalidate: mocks.invalidate,
}))
import { POST } from "./route"

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

const body = {
  agentId: "a1", workspaceId: "ws1", r2Key: "emails/fixture/raw",
  from: "sender@example.test", to: "recipient@example.test", subject: "Stored message",
  isWhitelisted: true, messageId: "<fixture@example.test>", inReplyTo: "", references: "",
}
const request = (value: unknown) => new NextRequest("http://localhost/api/email/notify", { method: "POST", body: JSON.stringify(value) })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.agent.mockResolvedValue({ id: "a1", runtimeId: "old-runtime", ownerId: "owner" })
  mocks.email.mockResolvedValue({ id: "email-1" })
  mocks.broadcast.mockResolvedValue(undefined)
  mocks.invalidate.mockResolvedValue(undefined)
})

describe("inbound email after legacy execution removal", () => {
  it.each([true, false])("stores whitelisted=%s email without creating legacy tasks or conversations", async isWhitelisted => {
    const response = await POST(request({ ...body, isWhitelisted }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(mocks.email).toHaveBeenCalledWith({}, expect.objectContaining({
      agentId: "a1", workspaceId: "ws1", r2Key: body.r2Key, fromEmail: body.from,
      toEmail: body.to, subject: body.subject, messageId: body.messageId, direction: "inbound", isWhitelisted,
    }))
    expect(mocks.conversation).not.toHaveBeenCalled()
    expect(mocks.task).not.toHaveBeenCalled()
    expect(mocks.broadcast).toHaveBeenCalledWith("owner", { type: "email.received", agentId: "a1" })
    expect(mocks.invalidate).toHaveBeenCalledTimes(2)
  })

  it.each([
    { isWhitelisted: true, start: "DTSTART:20261101T100000Z", scheduledAt: "2026-11-01T10:00:00.000Z", status: "scheduled" },
    { isWhitelisted: false, start: "DTSTART:20261101T100000Z", scheduledAt: "2026-11-01T10:00:00.000Z", status: "pending" },
    { isWhitelisted: true, start: "DTSTART;TZID=Ancient/Monthly:20260610T100000", zone: ANCIENT_MONTHLY_ZONE, scheduledAt: null, status: "pending" },
    { isWhitelisted: true, start: "", scheduledAt: null, status: "pending" },
    { isWhitelisted: false, start: "", scheduledAt: null, status: "pending" },
  ])("retains meeting records for whitelisted=$isWhitelisted and start=$start", async ({ isWhitelisted, start, zone = "", scheduledAt, status }) => {
    const meetingInfo = parseIcs([
      "BEGIN:VCALENDAR", "VERSION:2.0", zone, "BEGIN:VEVENT", start, "SUMMARY:Planning",
      "LOCATION:https://meet.google.com/abc-defg-hij",
      "ATTENDEE;CN=Guest:mailto:guest@example.test", "END:VEVENT", "END:VCALENDAR",
    ].filter(Boolean).join("\r\n"))
    const response = await POST(request({ ...body, isWhitelisted, meetingInfo }))
    expect(response.status).toBe(200)
    expect(mocks.email).toHaveBeenCalledWith({}, expect.objectContaining({ r2Key: body.r2Key, subject: body.subject }))
    expect(mocks.meeting).toHaveBeenCalledWith({}, expect.objectContaining({
      agentId: "a1", workspaceId: "ws1", title: "Planning", participants: ["guest@example.test"],
      status, isWhitelisted, scheduledAt,
    }))
    expect(mocks.task).not.toHaveBeenCalled()
  })

  it.each([
    { name: "missing notification fields", payload: { agentId: "a1" } },
    ...[
      { startTime: "2026-11-01T10:00:00", endTime: null },
      { startTime: "2026-02-30T10:00:00Z", endTime: null },
      { startTime: "2026-11-01T10:00:00+01:00", endTime: null },
      { startTime: null, endTime: "2026-11-01T11:00:00" },
    ].map(times => ({ name: JSON.stringify(times), payload: { ...body, meetingInfo: {
      title: "Planning", meetingUrl: "https://meet.google.com/abc-defg-hij", attendees: [], ...times,
    } } })),
  ])("rejects invalid notification $name before any data write", async ({ payload }) => {
    const response = await POST(request(payload))
    expect(response.status).toBe(400)
    expect(mocks.agent).not.toHaveBeenCalled()
    expect(mocks.email).not.toHaveBeenCalled()
    expect(mocks.meeting).not.toHaveBeenCalled()
    expect(mocks.conversation).not.toHaveBeenCalled()
    expect(mocks.task).not.toHaveBeenCalled()
  })

  it("retains mail storage when the old agent lookup has no result", async () => {
    mocks.agent.mockResolvedValue(null)
    expect((await POST(request(body))).status).toBe(200)
    expect(mocks.email).toHaveBeenCalledOnce()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
