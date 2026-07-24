import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockGetBotWakeContext = vi.fn()
const mockInsertBotAuditSessionReset = vi.fn()
const mockBroadcastToUser = vi.fn()
const mockPushAgentResetToMachine = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
        getBotWakeContext: (...a: unknown[]) => mockGetBotWakeContext(...a),
      },
      communityBotAuditLog: {
        insertBotAuditSessionReset: (...a: unknown[]) => mockInsertBotAuditSessionReset(...a),
      },
    },
  }
})

vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))

vi.mock("@/lib/community/bot-push", () => ({
  pushAgentResetToMachine: (...a: unknown[]) => mockPushAgentResetToMachine(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: ctx?.actor ?? "owner_1", email: "u@t.com", params })
  },
}))

vi.mock("@/lib/middleware/helpers", async () => {
  const { NextResponse } = require("next/server")
  const actual = await vi.importActual<typeof import("@/lib/middleware/helpers")>("@/lib/middleware/helpers")
  return {
    ...actual,
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

function req() {
  return new NextRequest("http://localhost/api/community/bots/b1/reset-session", {
    method: "POST",
  })
}

const ctx = { params: { id: "b1" } } as any

const READY_CTX = {
  state: "ready" as const,
  botUserId: "b1",
  name: "zoe",
  discriminator: "0042",
  machineId: "mac_1",
  runtime: "claude",
  ownerUserId: "owner_1",
}

function seedOwnedAndBound() {
  mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerUserId: "owner_1", machineId: "mac_1", runtime: "claude" })
  mockGetBotWakeContext.mockResolvedValue(READY_CTX)
}

describe("POST /api/community/bots/[id]/reset-session", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("non-owner → 404 (getBotOwnedBy already filters by ownerUserId) and never pushes / never touches audit", async () => {
    mockGetBotOwnedBy.mockResolvedValue(null)

    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    expect(mockPushAgentResetToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("bot has no active binding → 409 and never pushes / never touches audit", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerUserId: "owner_1", machineId: null, runtime: null })

    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(mockPushAgentResetToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
  })

  it("bot wake context not ready (bot_unbound) → 409 and never pushes / never touches audit", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", ownerUserId: "owner_1", machineId: "mac_1", runtime: "claude" })
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_unbound" })

    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(mockPushAgentResetToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
  })

  it("owner + bound + daemon offline (sent:0) → 409 and never touches audit / never broadcasts", async () => {
    seedOwnedAndBound()
    mockPushAgentResetToMachine.mockResolvedValue({ sent: 0 })

    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(mockPushAgentResetToMachine).toHaveBeenCalledTimes(1)
    expect(mockInsertBotAuditSessionReset).not.toHaveBeenCalled()
    expect(mockBroadcastToUser).not.toHaveBeenCalled()
  })

  it("owner + bound + daemon online (sent:1) → 200 with exactly one audit row + one broadcast", async () => {
    seedOwnedAndBound()
    mockPushAgentResetToMachine.mockResolvedValue({ sent: 1 })
    mockInsertBotAuditSessionReset.mockResolvedValue({
      id: "evt_1",
      createdAt: "2026-07-24T09:00:00.000Z",
    })
    mockBroadcastToUser.mockResolvedValue(undefined)

    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)

    expect(mockPushAgentResetToMachine).toHaveBeenCalledTimes(1)
    const [_env, machineId, args] = mockPushAgentResetToMachine.mock.calls[0]!
    expect(machineId).toBe("mac_1")
    expect(args).toMatchObject({ agentId: "b1" })
    expect(typeof args.launchId).toBe("string")
    expect(args.launchId.length).toBeGreaterThan(0)
    expect(args.config).toBeDefined()

    expect(mockInsertBotAuditSessionReset).toHaveBeenCalledTimes(1)
    expect(mockInsertBotAuditSessionReset).toHaveBeenCalledWith(expect.anything(), {
      botId: "b1",
      actorId: "owner_1",
    })
    expect(mockBroadcastToUser).toHaveBeenCalledTimes(1)
    expect(mockBroadcastToUser).toHaveBeenCalledWith(
      "owner_1",
      expect.objectContaining({
        type: "community:bot.audit_event",
        kind: "session_reset",
        botId: "b1",
      }),
    )
  })
})
