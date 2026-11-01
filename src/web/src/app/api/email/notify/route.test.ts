import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

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

  it.each([true, false])("retains meeting records for whitelisted=%s mail", async isWhitelisted => {
    const response = await POST(request({ ...body, isWhitelisted, meetingInfo: {
      title: "Planning", meetingUrl: "https://meet.example.test/room", startTime: "2026-11-01T10:00:00Z",
      endTime: null, attendees: [{ name: "Guest", email: "guest@example.test" }],
    } }))
    expect(response.status).toBe(200)
    expect(mocks.meeting).toHaveBeenCalledWith({}, expect.objectContaining({
      agentId: "a1", workspaceId: "ws1", title: "Planning", participants: ["guest@example.test"],
      status: isWhitelisted ? "scheduled" : "pending", isWhitelisted,
    }))
    expect(mocks.task).not.toHaveBeenCalled()
  })

  it("rejects invalid notification input before any data write", async () => {
    const response = await POST(request({ agentId: "a1" }))
    expect(response.status).toBe(400)
    expect(mocks.email).not.toHaveBeenCalled()
    expect(mocks.task).not.toHaveBeenCalled()
  })

  it("retains mail storage when the old agent lookup has no result", async () => {
    mocks.agent.mockResolvedValue(null)
    expect((await POST(request(body))).status).toBe(200)
    expect(mocks.email).toHaveBeenCalledOnce()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})
