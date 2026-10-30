import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockResolveOwnedBotActor = vi.fn()
const mockResolveBotActor = vi.fn()
vi.mock("./community-agent-runner-auth", () => ({
  resolveOwnedBotActor: (...a: unknown[]) => mockResolveOwnedBotActor(...a),
  resolveBotActor: (...a: unknown[]) => mockResolveBotActor(...a),
}))

let mockHumanCtx: Record<string, unknown> | null = {
  env: { DB: {} },
  userId: "human_1",
  email: "h@t.com",
  user: { isBot: false },
}
vi.mock("./auth", () => ({
  resolveHumanAuth: async () => {
    if (!mockHumanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    return { context: mockHumanCtx }
  },
}))

import { withCommunityActor, rejectBot, requireBot, type CommunityActor } from "./community-actor"

const handler = vi.fn(async (_req: NextRequest, ctx: any) => NextResponse.json({ ok: true, actor: ctx.actor }))

const bearer = (v: string) => new NextRequest("http://localhost/x", { headers: { Authorization: v } })

describe("withCommunityActor", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHumanCtx = { env: { DB: {} }, userId: "human_1", email: "h@t.com", user: { isBot: false } }
  })

  const wrapped = withCommunityActor(handler)

  it("resolves a crk_ bearer to a bot actor (kind:bot, userId=botUserId)", async () => {
    mockResolveBotActor.mockResolvedValue({
      kind: "bot",
      actor: { botUserId: "bot_1", ownerUserId: "owner_1", machineId: "m_1", isActive: true },
    })
    const res = await wrapped(bearer("Bearer crk_abc"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actor: CommunityActor }
    expect(body.actor).toEqual({ kind: "bot", userId: "bot_1", ownerUserId: "owner_1", machineId: "m_1", isActive: true })
  })

  it("a crk_ bearer that fails to resolve returns the error response and NEVER falls through to human", async () => {
    mockResolveBotActor.mockResolvedValue({
      kind: "error",
      response: NextResponse.json({ error: "runner key revoked or unrecognized" }, { status: 401 }),
    })
    const res = await wrapped(bearer("Bearer crk_bad"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "runner key revoked or unrecognized" })
    // The human path must not have run — handler saw no human actor.
    expect(handler).not.toHaveBeenCalled()
  })

  it("fails closed when a runner resolver unexpectedly returns not_bot", async () => {
    mockResolveBotActor.mockResolvedValue({ kind: "not_bot" })
    const req = bearer("Bearer crk_unexpected")
    req.headers.set("Cookie", "valid-human-session")
    const response = await wrapped(req)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "invalid runner key" })
    expect(handler).not.toHaveBeenCalled()
    expect(mockResolveOwnedBotActor).not.toHaveBeenCalled()
  })

  it("rejects an unsupported contract after validating a runner without invoking business code", async () => {
    mockResolveBotActor.mockResolvedValue({
      kind: "bot",
      actor: { botUserId: "bot_1", ownerUserId: "owner_1", machineId: "m_1", isActive: true },
    })
    const req = new NextRequest("http://localhost/api/community/operation", {
      headers: { Authorization: "Bearer crk_valid", [COMMUNITY_CONTRACT_HEADER]: "unsupported" },
    })
    const response = await wrapped(req)
    expect(response.status).toBe(400)
    expect(mockResolveBotActor).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  })

  it("routes a session request (no bearer) to the human path via the human credential resolver", async () => {
    const res = await wrapped(new NextRequest("http://localhost/x"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { actor: CommunityActor }
    expect(body.actor).toEqual({ kind: "human", userId: "human_1", email: "h@t.com", isBot: false })
    // Bot resolution must not have been attempted for a non-crk_ request.
    expect(mockResolveBotActor).not.toHaveBeenCalled()
  })


  it("propagates a human auth failure from the human credential resolver unchanged", async () => {
    mockHumanCtx = null
    const res = await wrapped(new NextRequest("http://localhost/x"))
    expect(res.status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([200, 304])("varies private bot media status %s by credentials without changing actor resolution", async (status) => {
    mockResolveBotActor.mockResolvedValue({
      kind: "bot",
      actor: { botUserId: "bot_1", ownerUserId: "owner_1", machineId: "m_1", isActive: true },
    })
    const original = new Response(status === 304 ? null : "media", {
      status, headers: { "Cache-Control": "private, max-age=31536000, immutable", Vary: "Accept-Encoding" },
    })
    const mediaHandler = vi.fn(async (_request: NextRequest, _ctx: { actor: CommunityActor }) => original)
    const res = await withCommunityActor(mediaHandler)(bearer("Bearer crk_abc"))
    expect(res.status).toBe(status)
    expect(res.headers.get("Vary")).toBe("Accept-Encoding, Cookie, Authorization, X-Alook-Bot-Id")
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
    expect(res.body).toBe(original.body)
    expect(mediaHandler.mock.calls[0]?.[1].actor.kind).toBe("bot")
  })
})

describe("rejectBot / requireBot guards", () => {
  const human: CommunityActor = { kind: "human", userId: "h", email: "e" }
  const bot: CommunityActor = { kind: "bot", userId: "b", ownerUserId: "o", machineId: "m", isActive: true }

  it("rejectBot: 403 for a bot, null for a human", () => {
    expect(rejectBot(bot)?.status).toBe(403)
    expect(rejectBot(human)).toBeNull()
  })

  it("requireBot: 403 for a human; narrows to the bot actor for a bot", () => {
    const humanGate = requireBot(human)
    expect(humanGate.ok).toBe(false)
    if (!humanGate.ok) expect(humanGate.response.status).toBe(403)

    const botGate = requireBot(bot)
    expect(botGate.ok).toBe(true)
    if (botGate.ok) expect(botGate.bot).toEqual({ kind: "bot", userId: "b", ownerUserId: "o", machineId: "m", isActive: true })
  })
})


describe("owner selected bot", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHumanCtx = { env: { DB: {} }, userId: "human_1", email: "h@t.com" }
    mockResolveOwnedBotActor.mockResolvedValue({ kind: "bot", actor: { botUserId: "bot_1", ownerUserId: "human_1", machineId: "offline_machine", isActive: true } })
  })
  const request = () => new NextRequest("http://localhost/api/community/servers/channels", { headers: { "X-Alook-Bot-Id": "bot_1", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } })
  it("authenticates the owner then delegates only the selected bot identity, with a private varied response", async () => {
    const response = await withCommunityActor(handler)(request())
    expect(mockResolveOwnedBotActor).toHaveBeenCalledWith({}, "bot_1", "human_1", { allowInactive: undefined })
    expect(await response.json()).toMatchObject({ actor: { kind: "bot", userId: "bot_1", ownerUserId: "human_1", machineId: "offline_machine", delegatedByUserId: "human_1" } })
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(response.headers.get("Vary")).toContain("X-Alook-Bot-Id")
    expect(mockResolveBotActor).not.toHaveBeenCalled()
  })
  it("does not resolve a selected bot before human authentication", async () => {
    mockHumanCtx = null
    expect((await withCommunityActor(handler)(request())).status).toBe(401)
    expect(mockResolveOwnedBotActor).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
  it("preserves owned bot lookup rejection without calling the route", async () => {
    mockResolveOwnedBotActor.mockResolvedValue({ kind: "error", response: NextResponse.json({ error: "bot not found" }, { status: 404 }) })
    expect((await withCommunityActor(handler)(request())).status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })
  it("rejects runner-key identity selection without falling through to human authentication", async () => {
    const req = request()
    req.headers.set("Authorization", "Bearer crk_a")
    expect((await withCommunityActor(handler)(req)).status).toBe(403)
    expect(mockResolveOwnedBotActor).not.toHaveBeenCalled()
    expect(mockResolveBotActor).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })
  it("passes the route's explicit inactive policy to owner delegation", async () => {
    await withCommunityActor(handler, { allowInactiveBot: true })(request())
    expect(mockResolveOwnedBotActor).toHaveBeenCalledWith({}, "bot_1", "human_1", { allowInactive: true })
  })
})
