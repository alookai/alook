import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { makeD1Error } from "@alook/shared/db/resilience-testing"

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
      user: {
        getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a),
      },
      communityBot: {
        getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a),
      },
    },
  }
})

import { withAgentRunnerAuth } from "./community-agent-runner-auth"

const handler = vi.fn(async (_req: NextRequest, ctx: any) => NextResponse.json({ ok: true, ctx }))

describe("withAgentRunnerAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const wrapped = withAgentRunnerAuth(handler)

  it("rejects when Authorization is missing", async () => {
    const req = new NextRequest("http://localhost/x")
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "missing or malformed Authorization header" })
  })

  it("rejects a non-crk_ bearer without querying the DB", async () => {
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer sk_something" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(mockFindActiveAgentRunnerKeyByBearer).not.toHaveBeenCalled()
  })

  it("rejects a revoked/unknown crk_ key", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_unknown" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "runner key revoked or unknown" })
  })

  it("rejects when the bot user is missing, not a bot, or soft-deleted", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    for (const badUser of [null, { isBot: false, deletedAt: null }, { isBot: true, deletedAt: "2026-01-01" }]) {
      mockGetUserInternal.mockResolvedValue(badUser)
      const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
      const res = await wrapped(req)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: "bot not found or inactive" })
    }
    expect(mockGetBotBinding).not.toHaveBeenCalled()
  })

  it("rejects on binding machine mismatch", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_OTHER", runtime: "claude" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "bot binding mismatch" })
  })

  it("rejects when no binding exists at all", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue(null)
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
  })

  it("populates ctx { botUserId, ownerUserId, machineId } on a valid crk_ for a live bot on the right machine", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ctx: any }
    // Field mapping must not be inverted: row.agentId → botUserId, row.userId → ownerUserId.
    expect(body.ctx).toMatchObject({
      botUserId: "bot_1",
      ownerUserId: "owner_1",
      machineId: "m_1",
    })
  })

  it("returns 503 + Retry-After when D1 exhausts retries on the runner-key lookup", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    mockFindActiveAgentRunnerKeyByBearer.mockRejectedValue(makeD1Error("internal_error"))
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("1")
    expect(await res.json()).toEqual({ error: "database temporarily unavailable" })
  }, 10_000)

  it("returns 503 when D1 exhausts on the getUserInternal step", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockRejectedValue(makeD1Error("sqlite_busy"))
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(503)
  }, 10_000)

  it("preserves 401 for non-D1 failures — bot deleted, no retry", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: "2026-01-01" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(mockGetUserInternal).toHaveBeenCalledTimes(1)
  })

  it("preserves 401 for binding mismatch — no retry", async () => {
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({
      userId: "owner_1",
      machineId: "m_1",
      agentId: "bot_1",
    })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_OTHER" })
    const req = new NextRequest("http://localhost/x", { headers: { Authorization: "Bearer crk_abc" } })
    const res = await wrapped(req)
    expect(res.status).toBe(401)
    expect(mockGetBotBinding).toHaveBeenCalledTimes(1)
  })
})
