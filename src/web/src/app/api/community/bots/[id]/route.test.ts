import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockUpdateBot = vi.fn()
const mockUpdateBotModel = vi.fn()
const mockGetBotWakeContext = vi.fn()
const mockInsertBotAuditModelChanged = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockPushAgentModelSwitchToMachine = vi.fn()
const mockBroadcastToUser = vi.fn()
const mockLogAudit = vi.fn()

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
        updateBot: (...a: unknown[]) => mockUpdateBot(...a),
        updateBotModel: (...a: unknown[]) => mockUpdateBotModel(...a),
        getBotWakeContext: (...a: unknown[]) => mockGetBotWakeContext(...a),
      },
      communityBotAuditLog: {
        insertBotAuditModelChanged: (...a: unknown[]) => mockInsertBotAuditModelChanged(...a),
      },
      user: {
        getUserPublic: (...a: unknown[]) => mockGetUserPublic(...a),
      },
    },
  }
})

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...a: unknown[]) => mockPushBotEventToMachine(...a),
  pushAgentModelSwitchToMachine: (...a: unknown[]) => mockPushAgentModelSwitchToMachine(...a),
}))
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: (...a: unknown[]) => mockBroadcastToUser(...a),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
}))
vi.mock("@/lib/community/audit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/audit")>("@/lib/community/audit")
  return { ...actual, logAudit: (...a: unknown[]) => mockLogAudit(...a) }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
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

import { PATCH } from "./route"

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/bots/b1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
const ctx = { params: { id: "b1" } } as any

describe("PATCH /api/community/bots/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: null,
    })
    mockUpdateBot.mockResolvedValue({
      id: "b1", name: "New", discriminator: "0001", description: "new desc", image: null,
    })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
    mockGetBotWakeContext.mockResolvedValue({
      state: "ready", botUserId: "b1", name: "Old", discriminator: "0001",
      machineId: "mac1", runtime: "claude", modelName: null, ownerUserId: "u1",
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 1, deliveryError: false })
    mockInsertBotAuditModelChanged.mockResolvedValue({ id: "evt_1", createdAt: "2026-07-26T00:00:00.000Z" })
    // A bound bot's model write matches its binding row by default.
    mockUpdateBotModel.mockResolvedValue(true)
  })

  it("updates and pushes bot:updated to the daemon when the name changed", async () => {
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBot).toHaveBeenCalled()
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({ type: "bot:updated", name: "New", ownerName: "Owner" }),
    )
  })

  it("resolves the owner BEFORE mutating: an unresolvable owner fails 500 without writing", async () => {
    mockGetUserPublic.mockResolvedValue(null)
    const res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(500)
    // The row must NOT have been mutated — otherwise a retry sees no diff and
    // never pushes, leaving the daemon prompt permanently stale.
    expect(mockUpdateBot).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
  })

  it("image-only change does not resolve the owner or push (display-only)", async () => {
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "Old", discriminator: "0001", description: "old desc", image: "avatar:sunset" })
    const res = await PATCH(patchReq({ image: "avatar:sunset" }), ctx)
    expect(res.status).toBe(200)
    expect(mockGetUserPublic).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
    expect(mockUpdateBot).toHaveBeenCalled()
  })

  it("changed model on a wake-ready bot: writes column, pushes new model, applied:true, one audit row", async () => {
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: boolean; deliveryError: boolean; bot: { modelName: string } }
    expect(body.applied).toBe(true)
    expect(body.deliveryError).toBe(false)
    expect(body.bot.modelName).toBe("claude-sonnet-4-6")
    expect(mockUpdateBotModel).toHaveBeenCalledWith(expect.anything(), "b1", "u1", "claude-sonnet-4-6")
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        agentId: "b1",
        config: expect.objectContaining({ model: { kind: "named", name: "claude-sonnet-4-6" } }),
      }),
    )
    expect(mockInsertBotAuditModelChanged).toHaveBeenCalledTimes(1)
    expect(mockInsertBotAuditModelChanged).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ botId: "b1", from: null, to: "claude-sonnet-4-6" }),
    )
  })

  it("changed model, daemon disconnected (sent 0): 200, applied:false, deliveryError:false, no audit", async () => {
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: false })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    const body = (await res.json()) as { applied: boolean; deliveryError: boolean }
    expect(res.status).toBe(200)
    expect(body.applied).toBe(false)
    expect(body.deliveryError).toBe(false)
    expect(mockUpdateBotModel).toHaveBeenCalled()
    expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
  })

  it("changed model, push transport error: 200, applied:false, deliveryError:true, no audit", async () => {
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: true })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    const body = (await res.json()) as { applied: boolean; deliveryError: boolean }
    expect(res.status).toBe(200)
    expect(body.applied).toBe(false)
    expect(body.deliveryError).toBe(true)
    expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
  })

  it("changed model but wake ctx not ready: no push, applied:false, column still written, never 409", async () => {
    mockGetBotWakeContext.mockResolvedValue({ state: "bot_unbound" })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: boolean }
    expect(body.applied).toBe(false)
    expect(mockUpdateBotModel).toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
  })

  it("model PATCH on a bot with no binding row → 409, does NOT claim the model was saved", async () => {
    // getBotOwnedBy passes (the bot exists + is owned) but the binding row is
    // absent, so updateBotModel matches zero rows.
    mockUpdateBotModel.mockResolvedValue(false)
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error?: string; bot?: { modelName: string } }
    // Must not echo the model as saved — it wasn't.
    expect(body.bot).toBeUndefined()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
    expect(mockInsertBotAuditModelChanged).not.toHaveBeenCalled()
  })

  it("same model / omitted model: no push, no audit, column untouched", async () => {
    // same: before.modelName is null, body sends null
    let res = await PATCH(patchReq({ model: null }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()

    // omitted: name-only patch
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "claude", modelName: null })
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "New", discriminator: "0001", description: "d", image: null })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
    res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
  })

  it("model:null on a bot that had one: clears column, pushes default, audits {from, to:null}", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "claude", modelName: "claude-opus-4-6" })
    mockGetBotWakeContext.mockResolvedValue({ state: "ready", botUserId: "b1", name: "Old", discriminator: "0001", machineId: "mac1", runtime: "claude", modelName: "claude-opus-4-6", ownerUserId: "u1" })
    const res = await PATCH(patchReq({ model: null }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).toHaveBeenCalledWith(expect.anything(), "b1", "u1", null)
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({ config: expect.objectContaining({ model: { kind: "default" } }) }),
    )
    expect(mockInsertBotAuditModelChanged).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: "claude-opus-4-6", to: null }),
    )
  })

  it("name AND model changed: both bot:updated and agent:model_switch pushed; audit changedFields includes both", async () => {
    const res = await PATCH(patchReq({ name: "New", model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(expect.anything(), "mac1", expect.objectContaining({ type: "bot:updated" }))
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalled()
    const auditCall = mockLogAudit.mock.calls.at(-1)?.[1] as { changes: string }
    const fields = JSON.parse(auditCall.changes).fields as string[]
    expect(fields).toContain("name")
    expect(fields).toContain("model")
  })

  it("model on an antigravity bot → 400; runtime null → allowed", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "antigravity", modelName: null })
    let res = await PATCH(patchReq({ model: "whatever" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: null, modelName: null })
    mockGetBotWakeContext.mockResolvedValue({ state: "ready", botUserId: "b1", name: "Old", discriminator: "0001", machineId: "mac1", runtime: "claude", modelName: null, ownerUserId: "u1" })
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "Old", discriminator: "0001", description: "d", image: null })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 1, deliveryError: false })
    mockInsertBotAuditModelChanged.mockResolvedValue({ id: "e", createdAt: "t" })
    res = await PATCH(patchReq({ model: "some-model" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).toHaveBeenCalled()
  })
})
