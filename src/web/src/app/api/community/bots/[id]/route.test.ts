import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockUpdateBot = vi.fn()
const mockUpdateBotModel = vi.fn()
const mockUpdateBotRuntime = vi.fn()
const mockGetMachineForOwner = vi.fn()
const mockIsBotOnline = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockPushAgentModelSwitchToMachine = vi.fn()
const mockPushAgentProviderSwitchToMachine = vi.fn()
const mockLogError = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: (...a: unknown[]) => mockLogError(...a),
      debug: vi.fn(),
    }),
    queries: {
      communityBot: {
        getBotOwnedBy: (...a: unknown[]) => mockGetBotOwnedBy(...a),
        updateBot: (...a: unknown[]) => mockUpdateBot(...a),
        updateBotModel: (...a: unknown[]) => mockUpdateBotModel(...a),
        updateBotRuntime: (...a: unknown[]) => mockUpdateBotRuntime(...a),
        getMachineForOwner: (...a: unknown[]) => mockGetMachineForOwner(...a),
      },
      communityMachine: {
        isBotOnline: (...a: unknown[]) => mockIsBotOnline(...a),
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
  pushAgentProviderSwitchToMachine: (...a: unknown[]) => mockPushAgentProviderSwitchToMachine(...a),
}))
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn(),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: vi.fn(),
}))

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
    mockIsBotOnline.mockResolvedValue(true)
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [
        { id: "claude", status: "healthy" },
        { id: "codex", status: "healthy" },
      ],
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 1, deliveryError: false })
    mockPushAgentProviderSwitchToMachine.mockResolvedValue({ sent: 1, deliveryError: false })
    mockUpdateBotModel.mockResolvedValue(true)
    mockUpdateBotRuntime.mockResolvedValue(true)
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

  // Melisa #1294 push-first: push then D1 write; offline/sent===0 never touch D1 runtime columns.
  it("changed model online: push-first then writes column; from/to on push; no dispatch-time audit", async () => {
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: boolean; deliveryError: boolean; bot: { modelName: string } }
    expect(body.applied).toBe(true)
    expect(body.deliveryError).toBe(false)
    expect(body.bot.modelName).toBe("claude-sonnet-4-6")
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        agentId: "b1",
        from: null,
        to: "claude-sonnet-4-6",
        config: expect.objectContaining({ model: { kind: "named", name: "claude-sonnet-4-6" } }),
      }),
    )
    expect(mockUpdateBotModel).toHaveBeenCalledWith(expect.anything(), "b1", "u1", "claude-sonnet-4-6")
    expect(mockPushAgentModelSwitchToMachine.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUpdateBotModel.mock.invocationCallOrder[0]!,
    )
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed provider online: push provider_switch first, then updateBotRuntime (clears model)", async () => {
    mockUpdateBot.mockResolvedValue({
      id: "b1", name: "Old", discriminator: "0001", description: "old desc", image: null,
    })
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: boolean; bot: { runtime: string; modelName: string | null } }
    expect(body.applied).toBe(true)
    expect(body.bot.runtime).toBe("codex")
    expect(body.bot.modelName).toBe(null)
    expect(mockPushAgentProviderSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        agentId: "b1",
        from: "claude",
        to: "codex",
        config: expect.objectContaining({ runtime: "codex" }),
      }),
    )
    expect(mockUpdateBotRuntime).toHaveBeenCalledWith(expect.anything(), "b1", "u1", "codex", null)
    expect(mockPushAgentProviderSwitchToMachine.mock.invocationCallOrder[0]!).toBeLessThan(
      mockUpdateBotRuntime.mock.invocationCallOrder[0]!,
    )
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed model, daemon offline (isBotOnline false): 409, no column write, no push", async () => {
    mockIsBotOnline.mockResolvedValue(false)
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
    expect(mockUpdateBotRuntime).not.toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed provider, daemon offline: 409, zero D1 write, no push", async () => {
    mockIsBotOnline.mockResolvedValue(false)
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotRuntime).not.toHaveBeenCalled()
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed model, push sent===0: 409, zero D1 runtime write (no soft-save, no rollback)", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: false })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
  })

  it("changed provider, push sent===0: 409, zero D1 runtime write", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentProviderSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: false })
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotRuntime).not.toHaveBeenCalled()
  })

  it("changed model, push transport error: 503, zero D1 runtime write", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: true })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(503)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
  })

  // Melisa #1294 / Cecilia #1295: push succeeded but D1 persist failed → explicit
  // log.error + 5xx (no silent divergence, UI must not toast success).
  it("changed model, sent>0 but D1 write throws: log.error(bot_runtime_switch_persist_failed) + 500", async () => {
    mockUpdateBotModel.mockRejectedValue(new Error("d1 down"))
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(500)
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_runtime_switch_persist_failed",
      expect.objectContaining({ botId: "b1", persistErr: expect.stringContaining("d1 down") }),
    )
  })

  it("changed provider, sent>0 but D1 write throws: log.error(bot_runtime_switch_persist_failed) + 500", async () => {
    mockUpdateBotRuntime.mockRejectedValue(new Error("d1 down"))
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(500)
    expect(mockPushAgentProviderSwitchToMachine).toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_runtime_switch_persist_failed",
      expect.objectContaining({ botId: "b1" }),
    )
  })

  it("model PATCH on a bot with no binding row after successful push → 500 + persist_failed log", async () => {
    mockUpdateBotModel.mockResolvedValue(false)
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(500)
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_runtime_switch_persist_failed",
      expect.objectContaining({ botId: "b1" }),
    )
  })

  it("same model / omitted model: no push, column untouched", async () => {
    let res = await PATCH(patchReq({ model: null }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "claude", modelName: null })
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "New", discriminator: "0001", description: "d", image: null })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
    res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
  })

  it("model:null on a bot that had one: push default with from/to, then clear column", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "claude", modelName: "claude-opus-4-6" })
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "Old", discriminator: "0001", description: "d", image: null })
    const res = await PATCH(patchReq({ model: null }), ctx)
    expect(res.status).toBe(200)
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        from: "claude-opus-4-6",
        to: null,
        config: expect.objectContaining({ model: { kind: "default" } }),
      }),
    )
    expect(mockUpdateBotModel).toHaveBeenCalledWith(expect.anything(), "b1", "u1", null)
  })

  it("name AND model changed: both bot:updated and model_switch are pushed", async () => {
    const res = await PATCH(patchReq({ name: "New", model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(expect.anything(), "mac1", expect.objectContaining({ type: "bot:updated" }))
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalled()
  })

  it("model on an antigravity bot → 400", async () => {
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "antigravity", modelName: null })
    const res = await PATCH(patchReq({ model: "whatever" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateBotModel).not.toHaveBeenCalled()
  })

  it("runtime not on machine → 400", async () => {
    const res = await PATCH(patchReq({ runtime: "gemini" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateBotRuntime).not.toHaveBeenCalled()
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })
})
