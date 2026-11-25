import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  actor: { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "cm_1", isActive: true } as any,
  wsDoFetch: vi.fn(),
  resolveMessageRefForBot: vi.fn(),
  requireDMAccess: vi.fn(),
  requireChannelMember: vi.fn(),
  requireMessageSurfaceAccess: vi.fn(),
  getUsersByIds: vi.fn(),
  listBotsForOwner: vi.fn(),
  getChannelType: vi.fn(),
  resolveUnreadNoticeChannel: vi.fn(),
  getMessagesByIdsInChannels: vi.fn(),
  listOwnerScheduleEvents: vi.fn(),
  getScheduleEventById: vi.fn(),
  createScheduleEvent: vi.fn(),
  updateScheduleEvent: vi.fn(),
  deleteScheduleEvent: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/broadcast", () => ({ wsDoFetch: (...args: unknown[]) => mocks.wsDoFetch(...args) }))
vi.mock("@/lib/community/resolve-message-ref", () => ({
  resolveMessageRefForBot: (...args: unknown[]) => mocks.resolveMessageRefForBot(...args),
}))
vi.mock("@/lib/community/permissions", () => ({
  requireDMAccess: (...args: unknown[]) => mocks.requireDMAccess(...args),
  requireChannelMember: (...args: unknown[]) => mocks.requireChannelMember(...args),
  requireMessageSurfaceAccess: (...args: unknown[]) => mocks.requireMessageSurfaceAccess(...args),
}))
vi.mock("@/lib/middleware/auth-policy", () => ({
  withAuth: (_policy: unknown, handler: any) => (req: NextRequest, routeCtx?: { params?: Promise<Record<string, string>> }) =>
    Promise.resolve(routeCtx?.params).then((params) => handler(req, { env: { DB: {} }, actor: mocks.actor, params })),
}))
vi.mock("@/lib/middleware/community-actor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/middleware/community-actor")>("@/lib/middleware/community-actor")
  return {
    ...actual,
    communityActorPolicy: () => ({}),
  }
})
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    withD1Retry: async <T>(fn: () => Promise<T>) => fn(),
    queries: {
      ...actual.queries,
      user: {
        ...actual.queries.user,
        getUsersByIds: (...args: unknown[]) => mocks.getUsersByIds(...args),
      },
      communityBot: {
        ...actual.queries.communityBot,
        listBotsForOwner: (...args: unknown[]) => mocks.listBotsForOwner(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        getChannelType: (...args: unknown[]) => mocks.getChannelType(...args),
      },
      communityAgentInbox: {
        ...actual.queries.communityAgentInbox,
        resolveUnreadNoticeChannel: (...args: unknown[]) => mocks.resolveUnreadNoticeChannel(...args),
      },
      communityMessage: {
        ...actual.queries.communityMessage,
        getMessagesByIdsInChannels: (...args: unknown[]) => mocks.getMessagesByIdsInChannels(...args),
      },
      communitySchedule: {
        ...actual.queries.communitySchedule,
        listOwnerScheduleEvents: (...args: unknown[]) => mocks.listOwnerScheduleEvents(...args),
        getScheduleEventById: (...args: unknown[]) => mocks.getScheduleEventById(...args),
        createScheduleEvent: (...args: unknown[]) => mocks.createScheduleEvent(...args),
        updateScheduleEvent: (...args: unknown[]) => mocks.updateScheduleEvent(...args),
        deleteScheduleEvent: (...args: unknown[]) => mocks.deleteScheduleEvent(...args),
      },
    },
  }
})

import { GET, POST } from "./route"
import { DELETE, GET as GET_ONE, PATCH } from "./[id]/route"

describe("schedule events API routes (D1 + DO sync-alarm + bot-only writes)", () => {
  const baseStoredEvent = {
    id: "sch_1",
    ownerUserId: "owner_1",
    createdByUserId: "bot_1",
    title: "Daily summary",
    description: "Summarize open items",
    startAtMs: Date.parse("2026-11-26T01:00:00.000Z"),
    durationMinutes: 30,
    timeZone: "Asia/Shanghai",
    recurrence: { freq: "daily" as const, interval: 1 },
    occurrenceCount: 1,
    nextRunAtMs: Date.parse("2026-11-27T01:00:00.000Z"),
    sourceMessageId: "msg_1",
    sourceChannelId: "ch_1",
    version: 1,
    createdAtMs: Date.parse("2026-11-25T04:00:00.000Z"),
    updatedAtMs: Date.parse("2026-11-25T04:00:00.000Z"),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.actor = { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "cm_1", isActive: true }
    mocks.wsDoFetch.mockResolvedValue(Response.json({ nextAlarmMs: baseStoredEvent.nextRunAtMs }))
    mocks.getUsersByIds.mockResolvedValue([
      { id: "owner_1", name: "gus", discriminator: "1813", avatarVersion: 1, isBot: false },
    ])
    mocks.listBotsForOwner.mockResolvedValue([
      { id: "bot_1", name: "Elwira", discriminator: "8700", avatarVersion: 2 },
    ])
    mocks.getChannelType.mockResolvedValue("text")
    mocks.requireChannelMember.mockResolvedValue({ ok: true, value: { id: "ch_1" } })
    mocks.resolveUnreadNoticeChannel.mockResolvedValue("/Alook#5620/gus-infra")
    mocks.getMessagesByIdsInChannels.mockResolvedValue([
      { id: "msg_1", channelId: "ch_1", seq: 42, content: "Track daily blockers here" },
    ])
    mocks.resolveMessageRefForBot.mockResolvedValue({ ok: true, messageId: "msg_1", channelId: "ch_1" })
    mocks.requireMessageSurfaceAccess.mockResolvedValue({ ok: true, value: { surface: "channel", channel: { id: "ch_1" } } })
  })

  it("allows bot POST to write D1 and sync DO alarm, and rejects human POST/PATCH/DELETE with 403", async () => {
    mocks.createScheduleEvent.mockResolvedValue({ ok: true, event: baseStoredEvent, latestRun: null })

    const botRes = await POST(new NextRequest("http://localhost/api/community/schedule/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Daily summary",
        description: "Summarize open items",
        startAt: "2026-11-26T01:00:00.000Z",
        timeZone: "Asia/Shanghai",
        recurrence: { freq: "daily", interval: 1 },
        sourceMessageRef: "/Alook#5620/gus-infra#42",
      }),
    }))
    expect(botRes.status).toBe(201)
    const body = (await botRes.json()) as { event: any }
    expect(body.event.id).toBe("sch_1")
    expect(body.event.createdBy.handle).toBe("@Elwira#8700")
    expect(body.event.sourceMessage).toMatchObject({
      id: "msg_1",
      accessible: true,
      status: "accessible",
      ref: "/Alook#5620/gus-infra#42",
      seq: 42,
    })
    expect(mocks.wsDoFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/owner-schedule/owner_1/sync-alarm",
      expect.objectContaining({ method: "POST" }),
      expect.anything(),
    )

    mocks.actor = { kind: "human", userId: "owner_1", email: "gus@test.local" }
    const humanPost = await POST(new NextRequest("http://localhost/api/community/schedule/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Human create",
        startAt: "2026-11-26T01:00:00.000Z",
        timeZone: "UTC",
        sourceMessageRef: "/Alook#5620/gus-infra#42",
      }),
    }))
    expect(humanPost.status).toBe(403)

    const humanPatch = await PATCH(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Human edit" }),
      }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(humanPatch.status).toBe(403)

    const humanDelete = await DELETE(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(humanDelete.status).toBe(403)
    expect(mocks.updateScheduleEvent).not.toHaveBeenCalled()
    expect(mocks.deleteScheduleEvent).not.toHaveBeenCalled()
  })

  it("allows human GET list and detail, redacting inaccessible source message fields and listing only bot creators", async () => {
    mocks.actor = { kind: "human", userId: "owner_1", email: "gus@test.local" }
    mocks.requireChannelMember.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    mocks.listOwnerScheduleEvents.mockResolvedValue({
      events: [baseStoredEvent],
      runsByEvent: { sch_1: [] },
      latestRunByEvent: { sch_1: null },
    })

    const res = await GET(new NextRequest(
      "http://localhost/api/community/schedule/events?from=2026-11-25T00:00:00.000Z&to=2026-11-28T00:00:00.000Z",
    ))
    expect(res.status).toBe(200)
    expect(mocks.wsDoFetch).not.toHaveBeenCalled()
    const data = (await res.json()) as { events: any[]; occurrences: any[]; creators: any[] }
    expect(data.events).toHaveLength(1)
    expect(data.events[0].sourceMessage).toEqual({
      id: "msg_1",
      accessible: false,
      status: "inaccessible",
      ref: null,
      channelRef: null,
      seq: null,
      preview: null,
    })
    expect(data.occurrences).toHaveLength(2)
    expect(data.creators.map((c) => c.handle)).toEqual(["@Elwira#8700"])

    mocks.getScheduleEventById.mockResolvedValue({ event: baseStoredEvent, latestRun: null })
    const detailRes = await GET_ONE(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1"),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(detailRes.status).toBe(200)
    const detailData = (await detailRes.json()) as { event: { id: string } }
    expect(detailData.event.id).toBe("sch_1")
  })

  it("enforces owner scoping on bot DELETE and supports bot PATCH --ack with completed status & ackedAt", async () => {
    mocks.actor = { kind: "bot", userId: "bot_other", ownerUserId: "owner_other", machineId: "cm_2", isActive: true }
    mocks.deleteScheduleEvent.mockResolvedValue(false)

    const crossDel = await DELETE(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(crossDel.status).toBe(404)
    expect(mocks.deleteScheduleEvent).toHaveBeenCalledWith(expect.anything(), "owner_other", "sch_1")
    expect(mocks.wsDoFetch).not.toHaveBeenCalled()

    const ackedAtMs = Date.parse("2026-11-26T01:05:00.000Z")
    mocks.actor = { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "cm_1", isActive: true }
    mocks.updateScheduleEvent.mockResolvedValue({
      ok: true,
      event: baseStoredEvent,
      latestRun: {
        id: "srun_1",
        ownerUserId: "owner_1",
        eventId: "sch_1",
        eventVersion: 1,
        botUserId: "bot_1",
        scheduledAtMs: Date.parse("2026-11-26T01:00:00.000Z"),
        sourceMessageId: "msg_1",
        sourceChannelId: "ch_1",
        titleSnapshot: "Daily summary",
        descriptionSnapshot: "Summarize open items",
        status: "completed",
        lastError: null,
        ackedAtMs,
        createdAtMs: Date.parse("2026-11-26T01:00:00.000Z"),
        updatedAtMs: ackedAtMs,
      },
    })
    const ackRes = await PATCH(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ack: true }),
      }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(ackRes.status).toBe(200)
    const ackBody = (await ackRes.json()) as { event: { lastExecution: { status: string; ackedAt: string | null } } }
    expect(ackBody.event.lastExecution).toMatchObject({
      status: "completed",
      ackedAt: "2026-11-26T01:05:00.000Z",
    })
    expect(mocks.wsDoFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/owner-schedule/owner_1/sync-alarm",
      expect.objectContaining({
        body: JSON.stringify({ ownerUserId: "owner_1", eventId: "sch_1", reason: "run_updated" }),
      }),
      expect.anything(),
    )

    mocks.deleteScheduleEvent.mockResolvedValue(true)
    const ownDel = await DELETE(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(ownDel.status).toBe(204)
  })

  it("checks creator bot surface access via requireMessageSurfaceAccess on sibling bot rebind", async () => {
    mocks.actor = { kind: "bot", userId: "bot_2", ownerUserId: "owner_1", machineId: "cm_1", isActive: true }
    mocks.resolveMessageRefForBot.mockResolvedValue({ ok: true, messageId: "msg_thread", channelId: "thr_1" })
    mocks.getScheduleEventById.mockResolvedValueOnce({ event: baseStoredEvent, latestRun: null })
    mocks.requireMessageSurfaceAccess.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })

    const denied = await PATCH(
      new NextRequest("http://localhost/api/community/schedule/events/sch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceMessageRef: "/Alook#5620/gus-infra/#10#2" }),
      }),
      { params: Promise.resolve({ id: "sch_1" }) },
    )
    expect(denied.status).toBe(403)
    expect(mocks.requireMessageSurfaceAccess).toHaveBeenCalledWith(expect.anything(), "thr_1", "bot_1")
  })
})
