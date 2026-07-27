import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMachine: {
        findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a),
      },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      machineToken: {
        getMachineTokenByToken: vi.fn(),
        updateMachineTokenLastUsed: vi.fn(),
      },
    },
  }
})

const mockGetSession = vi.fn()
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({ api: { getSession: mockGetSession, signOut: vi.fn() } })),
}))

import { withCommunityActor } from "./community-actor"

const handler = vi.fn(async (_req: NextRequest, ctx: any) => NextResponse.json({ ok: true, ctx }))

describe("withCommunityActor", () => {
  beforeEach(() => vi.clearAllMocks())

  const wrapped = withCommunityActor(handler)

  it("resolves a valid crk_ to a bot actor { userId=botUserId, isBot, ownerUserId, machineId }", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx).toMatchObject({ userId: "bot_1", isBot: true, ownerUserId: "owner_1", machineId: "m_1" })
  })

  it("rejects a revoked crk_ with 401 (does not fall through to human path)", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_bad" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it("rejects a crk_ with binding mismatch (401, no session fallthrough)", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_OTHER" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it("delegates a session to withAuth and yields a human actor { isBot:false }", async () => {
    mockGetSession.mockResolvedValue({
      headers: new Headers(),
      response: { user: { id: "user-1", email: "u@example.com" } },
    })
    mockGetUserInternal.mockResolvedValue({ isBot: false, deletedAt: null })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer some-session" } })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx).toMatchObject({ userId: "user-1", isBot: false, email: "u@example.com" })
    expect(body.ctx.ownerUserId).toBeUndefined()
    expect(mockFindActiveAgentRunnerKeyByBearer).not.toHaveBeenCalled()
  })

  it("returns 401 when neither crk_ nor a valid session is present", async () => {
    mockGetSession.mockResolvedValue({ headers: new Headers(), response: null })
    const req = new NextRequest("http://localhost/x")
    const res = await wrapped(req)
    expect(res.status).toBe(401)
  })

  it("does not run the runner-key lookup for a non-crk_ bearer", async () => {
    mockGetSession.mockResolvedValue({ headers: new Headers(), response: null })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer al_or_session" } })
    await wrapped(req)
    expect(mockFindActiveAgentRunnerKeyByBearer).not.toHaveBeenCalled()
  })

  it("resolves dynamic params on the bot path", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req, { params: Promise.resolve({ id: "chn_1" }) })
    const body = (await res.json()) as { ctx: any }
    expect(body.ctx.params).toEqual({ id: "chn_1" })
  })
})
