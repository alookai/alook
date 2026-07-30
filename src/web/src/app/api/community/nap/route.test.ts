import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotWakeContext = vi.fn()
const mockInsertBotAuditNap = vi.fn()
const mockTouchBotRefreshContext = vi.fn()
const mockPushAgentNapToMachine = vi.fn()

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
        getBotWakeContext: (...a: unknown[]) => mockGetBotWakeContext(...a),
        touchBotRefreshContext: (...a: unknown[]) => mockTouchBotRefreshContext(...a),
      },
      communityBotAuditLog: {
        insertBotAuditNap: (...a: unknown[]) => mockInsertBotAuditNap(...a),
      },
    },
  }
})

vi.mock("@/lib/community/bot-push", () => ({
  pushAgentNapToMachine: (...a: unknown[]) => mockPushAgentNapToMachine(...a),
}))

// Unified actor: nap is a bot-only verb (moved from /agent/nap to /community/nap,
// plans/22 §9). withCommunityActor injects the resolved actor; the bot acts on
// ITSELF — botUserId/machineId come from the authenticated runner, not the body.
// requireBot is a passthrough for a bot actor (human → 403, covered by the
// community-actor unit test). This test mocks the wrapper directly (as the
// incoming /agent/nap test did) so it stays focused on the nap handler logic.
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any) =>
    handler(req, {
      env: { DB: {} },
      actor: { kind: "bot", userId: "b1", ownerUserId: "owner_1", machineId: "mac_1" },
    }),
  requireBot: (actor: any) =>
    actor.kind === "bot"
      ? { ok: true, bot: actor }
      : { ok: false, response: new Response(null, { status: 403 }) },
}))

import { POST } from "./route"

function req(body: unknown = { handoff: "note to future self" }) {
  return new NextRequest("http://localhost/api/community/nap", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

const READY_CTX = {
  state: "ready" as const,
  botUserId: "b1",
  name: "zoe",
  discriminator: "0042",
  machineId: "mac_1",
  runtime: "claude",
  modelName: "claude-opus-4-6",
  ownerUserId: "owner_1",
}

describe("POST /api/community/nap", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("missing handoff → 400 and never pushes / never touches audit", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(mockPushAgentNapToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
    expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
  })

  it("bot wake context not ready → 409 and never pushes / never touches audit", async () => {
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_unbound" })

    const res = await POST(req())
    expect(res.status).toBe(409)
    expect(mockPushAgentNapToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
    expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
  })

  it("daemon offline (sent:0) → 409, writes NO audit row and does NOT stamp lastRefreshContextAt", async () => {
    mockGetBotWakeContext.mockResolvedValue(READY_CTX)
    mockPushAgentNapToMachine.mockResolvedValue({ sent: 0 })

    const res = await POST(req())
    expect(res.status).toBe(409)
    expect(mockPushAgentNapToMachine).toHaveBeenCalledTimes(1)
    // No delivery → no audit row → no refresh happened → timestamp not stamped
    // (they share the one chokepoint; a request that never landed isn't a nap).
    expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
    expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
  })

  it("daemon online (sent:1) → 200, writes one nap audit row and stamps lastRefreshContextAt once with the audit row's OWN createdAt", async () => {
    mockGetBotWakeContext.mockResolvedValue(READY_CTX)
    mockPushAgentNapToMachine.mockResolvedValue({ sent: 1 })
    mockInsertBotAuditNap.mockResolvedValue({
      id: "evt_1",
      createdAt: "2026-07-30T09:00:00.000Z",
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { napped: boolean }
    expect(body.napped).toBe(true)

    expect(mockInsertBotAuditNap).toHaveBeenCalledTimes(1)
    expect(mockInsertBotAuditNap).toHaveBeenCalledWith(expect.anything(), { botId: "b1" })

    // Single-source invariant (mirror of reset-session): lastRefreshContextAt is
    // stamped exactly once, in lockstep with the nap audit row, reusing that
    // row's OWN createdAt — so the my-bots "last refreshed" indicator can never
    // drift from the nap audit event. (Ported onto the moved /community/nap route
    // during the rebase — the /agent/nap this feature originally patched is gone.)
    expect(mockTouchBotRefreshContext).toHaveBeenCalledTimes(1)
    expect(mockTouchBotRefreshContext).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "2026-07-30T09:00:00.000Z",
    )
  })

  it("audit insert returns null (not inserted) → does NOT stamp lastRefreshContextAt", async () => {
    mockGetBotWakeContext.mockResolvedValue(READY_CTX)
    mockPushAgentNapToMachine.mockResolvedValue({ sent: 1 })
    mockInsertBotAuditNap.mockResolvedValue(null)

    const res = await POST(req())
    expect(res.status).toBe(200)
    // inserted guard: no audit row landed → no stamp (touch rides the audit row).
    expect(mockInsertBotAuditNap).toHaveBeenCalledTimes(1)
    expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
  })
})
