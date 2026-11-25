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
    },
  }
})

import { GET, POST } from "./route"
import { DELETE, PATCH } from "./[id]/route"

describe("calendar events API routes", () => {
  const baseStoredEvent = {
    id: "cal_1",
    ownerUserId: "owner_1",
    createdByUserId: "bot_1",
    title: "Daily summary",
    description: "Summarize open items",
    startAtMs: Date.parse("2026-11-26T01:00:00.000Z"),
    durationMinutes: 30,
    timeZone: "Asia/Shanghai",
    recurrence: { freq: "daily", interval: 1 },
    occurrenceCount: 1,
    nextRunAtMs: Date.parse("2026-11-27T01:00:00.000Z"),
    paused: false,
    sourceMessageId: "msg_1",
    sourceChannelId: "ch_1",
    version: 1,
    createdAtMs: Date.parse("2026-11-25T04:00:00.000Z"),
    updatedAtMs: Date.parse("2026-11-25T04:00:00.000Z"),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.actor = { kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "cm_1", isActive: true }
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

  it("allows bot POST with mandatory sourceMessageRef and rejects human POST (403)", async () => {
    mocks.wsDoFetch.mockResolvedValue(Response.json({ event: baseStoredEvent, latestRun: null }, { status: 201 }))

    const botRes = await POST(new NextRequest("http://localhost/api/community/calendar/events", {
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
    expect(body.event.id).toBe("cal_1")
    expect(body.event.createdBy.handle).toBe("@Elwira#8700")
    expect(body.event.sourceMessage).toMatchObject({
      id: "msg_1",
      accessible: true,
      status: "accessible",
      ref: "/Alook#5620/gus-infra#42",
      seq: 42,
    })

    // Human POST is forbidden in v1
    mocks.actor = { kind: "human", userId: "owner_1", email: "gus@test.local" }
    const humanRes = await POST(new NextRequest("http://localhost/api/community/calendar/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Human create",
        startAt: "2026-11-26T01:00:00.000Z",
        timeZone: "UTC",
        sourceMessageRef: "/Alook#5620/gus-infra#42",
      }),
    }))
    expect(humanRes.status).toBe(403)
  })

  it("redacts ref, channelRef, seq, and preview when caller loses access to source message", async () => {
    mocks.actor = { kind: "human", userId: "owner_1", email: "gus@test.local" }
    mocks.requireChannelMember.mockResolvedValue({ ok: false, status: 403, error: "forbidden" })
    mocks.wsDoFetch.mockResolvedValue(Response.json({
      events: [baseStoredEvent],
      runsByEvent: { cal_1: [] },
      latestRunByEvent: { cal_1: null },
    }))

    const res = await GET(new NextRequest(
      "http://localhost/api/community/calendar/events?from=2026-11-25T00:00:00.000Z&to=2026-11-28T00:00:00.000Z",
    ))
    expect(res.status).toBe(200)
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
    expect(data.creators.map((c) => c.handle)).toContain("@Elwira#8700")
  })

  it("scopes DO routing to the authenticated owner (cross-household isolation) and supports human PATCH/DELETE", async () => {
    mocks.actor = { kind: "human", userId: "owner_other", email: "other@test.local" }
    mocks.wsDoFetch.mockResolvedValue(Response.json({ error: "event not found" }, { status: 404 }))

    const crossDel = await DELETE(
      new NextRequest("http://localhost/api/community/calendar/events/cal_1", { method: "DELETE" }),
      { params: Promise.resolve({ id: "cal_1" }) },
    )
    expect(crossDel.status).toBe(404)
    expect(mocks.wsDoFetch).toHaveBeenCalledWith(
      expect.anything(),
      "/owner-calendar/owner_other/events/cal_1",
      expect.anything(),
      expect.anything(),
    )

    // Owner PATCH updates event
    mocks.actor = { kind: "human", userId: "owner_1", email: "gus@test.local" }
    mocks.wsDoFetch.mockResolvedValue(Response.json({
      event: { ...baseStoredEvent, title: "Updated summary", paused: true },
      latestRun: null,
    }))
    const patchRes = await PATCH(
      new NextRequest("http://localhost/api/community/calendar/events/cal_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Updated summary", paused: true }),
      }),
      { params: Promise.resolve({ id: "cal_1" }) },
    )
    expect(patchRes.status).toBe(200)
    const patched = (await patchRes.json()) as { event: { title: string; paused: boolean } }
    expect(patched.event).toMatchObject({ title: "Updated summary", paused: true })
  })

  it("checks creator bot surface access via requireMessageSurfaceAccess on sibling bot rebind", async () => {
    mocks.actor = { kind: "bot", userId: "bot_2", ownerUserId: "owner_1", machineId: "cm_1", isActive: true }
    mocks.resolveMessageRefForBot.mockResolvedValue({ ok: true, messageId: "msg_thread", channelId: "thr_1" })
    mocks.wsDoFetch.mockResolvedValueOnce(Response.json({ event: baseStoredEvent, latestRun: null }))
    mocks.requireMessageSurfaceAccess.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" })

    const denied = await PATCH(
      new NextRequest("http://localhost/api/community/calendar/events/cal_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceMessageRef: "/Alook#5620/gus-infra/#10#2" }),
      }),
      { params: Promise.resolve({ id: "cal_1" }) },
    )
    expect(denied.status).toBe(403)
    expect(mocks.requireMessageSurfaceAccess).toHaveBeenCalledWith(expect.anything(), "thr_1", "bot_1")
  })
})
