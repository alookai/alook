import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetMachineByIdForUser = vi.fn()
const mockListBotsForMachine = vi.fn()
const mockPushBatchResetToMachine = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMachine: {
        getMachineByIdForUser: (...a: unknown[]) => mockGetMachineByIdForUser(...a),
      },
      communityBot: {
        listBotsForMachine: (...a: unknown[]) => mockListBotsForMachine(...a),
      },
    },
  }
})

vi.mock("@/lib/community/bot-push", () => ({
  pushBatchResetToMachine: (...a: unknown[]) => mockPushBatchResetToMachine(...a),
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
  return new NextRequest("http://localhost/api/community/machines/mac_1/reset-agents", {
    method: "POST",
  })
}

const ctx = { params: { id: "mac_1" } } as any

// Two bots bound to the machine — one with a configured model, one default —
// AND deliberately one that would be idle (scope ②: batch resets ALL bound,
// running or not; the route doesn't filter by running state).
const BOUND_BOTS = [
  { id: "b1", name: "zoe", discriminator: "0042", description: "", ownerName: "o", ownerDiscriminator: "0001", runtime: "claude", modelName: "claude-opus-4-6" },
  { id: "b2", name: "max", discriminator: "0043", description: "", ownerName: "o", ownerDiscriminator: "0001", runtime: "claude", modelName: null },
]

describe("POST /api/community/machines/[id]/reset-agents (batch reset)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("non-owner (machine not owned) → 404, never enumerates bots, never pushes", async () => {
    mockGetMachineByIdForUser.mockResolvedValue(null)

    const res = await POST(req(), ctx)
    expect(res.status).toBe(404)
    expect(mockListBotsForMachine).not.toHaveBeenCalled()
    expect(mockPushBatchResetToMachine).not.toHaveBeenCalled()
  })

  it("owner but no bots bound → 200 {dispatched:0}, never pushes", async () => {
    mockGetMachineByIdForUser.mockResolvedValue({ id: "mac_1", userId: "owner_1" })
    mockListBotsForMachine.mockResolvedValue([])

    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { dispatched: number }
    expect(body.dispatched).toBe(0)
    expect(mockPushBatchResetToMachine).not.toHaveBeenCalled()
  })

  it("owner + bots bound + daemon offline (sent:0) → 409", async () => {
    mockGetMachineByIdForUser.mockResolvedValue({ id: "mac_1", userId: "owner_1" })
    mockListBotsForMachine.mockResolvedValue(BOUND_BOTS)
    mockPushBatchResetToMachine.mockResolvedValue({ sent: 0 })

    const res = await POST(req(), ctx)
    expect(res.status).toBe(409)
    expect(mockPushBatchResetToMachine).toHaveBeenCalledTimes(1)
  })

  it("owner + bots bound + daemon online → 200 {dispatched:N} with ONE batch frame carrying all agents", async () => {
    mockGetMachineByIdForUser.mockResolvedValue({ id: "mac_1", userId: "owner_1" })
    mockListBotsForMachine.mockResolvedValue(BOUND_BOTS)
    mockPushBatchResetToMachine.mockResolvedValue({ sent: 2 })

    const res = await POST(req(), ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as { dispatched: number }
    expect(body.dispatched).toBe(2)

    // ONE push (batch), NOT N single pushes (Gus: dedicated command, not fan-out).
    expect(mockPushBatchResetToMachine).toHaveBeenCalledTimes(1)
    const [_env, machineId, resets] = mockPushBatchResetToMachine.mock.calls[0]!
    expect(machineId).toBe("mac_1")
    expect(resets).toHaveLength(2)
    expect(resets.map((r: any) => r.agentId).sort()).toEqual(["b1", "b2"])
    // Each entry carries its own launchId + config.
    for (const r of resets) {
      expect(typeof r.launchId).toBe("string")
      expect(r.launchId.length).toBeGreaterThan(0)
      expect(r.config).toBeDefined()
    }
  })

  it("regression: per-agent config carries the bot's configured model (not default), resolved independently", async () => {
    mockGetMachineByIdForUser.mockResolvedValue({ id: "mac_1", userId: "owner_1" })
    mockListBotsForMachine.mockResolvedValue(BOUND_BOTS)
    mockPushBatchResetToMachine.mockResolvedValue({ sent: 2 })

    await POST(req(), ctx)
    const [, , resets] = mockPushBatchResetToMachine.mock.calls[0]!
    const b1 = resets.find((r: any) => r.agentId === "b1")!
    const b2 = resets.find((r: any) => r.agentId === "b2")!
    // b1 has a named model, b2 falls back to default — resolved per-agent.
    expect(b1.config.model).toEqual({ kind: "named", name: "claude-opus-4-6" })
    expect(b2.config.model).toEqual({ kind: "default" })
  })
})
