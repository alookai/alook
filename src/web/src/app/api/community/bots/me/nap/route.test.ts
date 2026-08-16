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
  return new NextRequest("http://localhost/api/community/bots/me/nap", {
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

describe("POST /api/community/bots/me/nap", () => {
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

  it("daemon online (sent:1) → 200 dispatch-only; nap audit + awake stamp re-homed to daemon completion, NOT written here", async () => {
    mockGetBotWakeContext.mockResolvedValue(READY_CTX)
    mockPushAgentNapToMachine.mockResolvedValue({ sent: 1 })
    const handoff = "  note \\\\n to future self\n中文 🎉  \n"

    const res = await POST(req({ handoff }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { napped: boolean }
    expect(body.napped).toBe(true)

    expect(mockPushAgentNapToMachine).toHaveBeenCalledTimes(1)
    const [, machineId, args] = mockPushAgentNapToMachine.mock.calls[0]!
    expect(machineId).toBe("mac_1")
    expect(args).toMatchObject({ agentId: "b1", handoff })
    expect(typeof args.launchId).toBe("string")
    expect(args.launchId.length).toBeGreaterThan(0)

    // The `nap` audit row + lastRefreshContextAt stamp are re-homed to the daemon
    // completion signal (agent_session frame at reborn-ready), so the record
    // reflects "the nap actually completed," not "the command was dispatched."
    // The route must NOT write either. See plans/reset-nap-completion-rehome.md.
    expect(mockInsertBotAuditNap).not.toHaveBeenCalled()
    expect(mockTouchBotRefreshContext).not.toHaveBeenCalled()
  })
})
