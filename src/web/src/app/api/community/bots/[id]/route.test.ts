import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetBotOwnedBy = vi.fn()
const mockUpdateBot = vi.fn()
const mockUpdateBotModel = vi.fn()
const mockUpdateBotRuntime = vi.fn()
const mockUpdateBotRuntimeConfig = vi.fn()
const mockGetMachineForOwner = vi.fn()
const mockIsBotOnline = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockPushAgentModelSwitchToMachine = vi.fn()
const mockPushAgentProviderSwitchToMachine = vi.fn()
const mockPushAgentRuntimeConfigUpdateToMachine = vi.fn()
const mockLogError = vi.fn()
const mockListBotServerMemberships = vi.fn()
const mockSoftDeleteBot = vi.fn()
const mockFanOutToServerMembers = vi.fn()
const mockGetCloudflareContext = vi.fn()
const mockWaitUntil = vi.fn()
const mockMediaDelete = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...args: unknown[]) => mockGetCloudflareContext(...args),
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
        updateBotRuntimeConfig: (...a: unknown[]) => mockUpdateBotRuntimeConfig(...a),
        getMachineForOwner: (...a: unknown[]) => mockGetMachineForOwner(...a),
        listBotServerMemberships: (...a: unknown[]) => mockListBotServerMemberships(...a),
        softDeleteBot: (...a: unknown[]) => mockSoftDeleteBot(...a),
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
  pushAgentRuntimeConfigUpdateToMachine: (...a: unknown[]) => mockPushAgentRuntimeConfigUpdateToMachine(...a),
}))
vi.mock("@/lib/broadcast", () => ({
  broadcastToUser: vi.fn(),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOutToServerMembers(...a),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {}, COMMUNITY_MEDIA: { delete: (...a: unknown[]) => mockMediaDelete(...a) } },
      userId: "u1",
      email: "u@t.com",
      params,
    })
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

import { DELETE, GET, PATCH } from "./route"

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/bots/b1", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
const ctx = { params: { id: "b1" } } as any

describe("GET /api/community/bots/[id]", () => {
  it("returns the owned bot with a canonical versioned avatar", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1",
      name: "Bot",
      discriminator: "0042",
      image: "/api/community/bots/b1/avatar",
      avatarVersion: 4,
      description: "helper",
      machineId: "mac1",
      runtime: "codex",
      modelName: null,
      reasoningEffort: null,
      runtimeConfigRevision: 2,
    })

    const res = await GET(
      new NextRequest("http://localhost/api/community/bots/b1"),
      ctx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      bot: {
        id: "b1",
        image: "/api/community/bots/b1/avatar?v=4",
        avatarVersion: 4,
      },
    })
  })
})

describe("PATCH /api/community/bots/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: null, reasoningEffort: null, runtimeConfigRevision: 0,
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
    mockUpdateBotRuntimeConfig.mockResolvedValue({ runtimeConfigRevision: 1 })
    mockPushAgentRuntimeConfigUpdateToMachine.mockResolvedValue({ sent: 1, deliveryError: false })
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

  it("changed model online: persists desired config before the best-effort push", async () => {
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
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "claude",
      modelName: "claude-sonnet-4-6",
      reasoningEffort: null,
    })
    expect(mockUpdateBotRuntimeConfig.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPushAgentModelSwitchToMachine.mock.invocationCallOrder[0]!,
    )
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed provider online: persists the full tuple before provider_switch", async () => {
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
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "codex",
      modelName: null,
      reasoningEffort: null,
    })
    expect(mockUpdateBotRuntimeConfig.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPushAgentProviderSwitchToMachine.mock.invocationCallOrder[0]!,
    )
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
  })

  it("switches a stored removed runtime to a supported runtime without rewriting the row first", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "gemini", modelName: "legacy-model",
    })
    mockUpdateBot.mockResolvedValue({
      id: "b1", name: "Old", discriminator: "0001", description: "old desc", image: null,
    })

    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)

    expect(res.status).toBe(200)
    expect(mockPushAgentProviderSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        agentId: "b1",
        from: "gemini",
        to: "codex",
        config: expect.objectContaining({ runtime: "codex", model: { kind: "default" } }),
      }),
    )
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "codex",
      modelName: null,
      reasoningEffort: null,
    })
  })

  it("changed model, daemon offline (isBotOnline false): 409, no column write, no push", async () => {
    mockIsBotOnline.mockResolvedValue(false)
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed provider, daemon offline: 409, zero D1 write, no push", async () => {
    mockIsBotOnline.mockResolvedValue(false)
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(409)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })

  it("changed model, push sent===0: keeps the saved desired config and reports deferred", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: false })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      deliveryError: false,
      application: "saved_not_applied",
      bot: { modelName: "claude-sonnet-4-6", runtimeConfigRevision: 1 },
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledOnce()
  })

  it("changed provider, push sent===0: keeps the saved desired config and reports deferred", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentProviderSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: false })
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      application: "saved_not_applied",
      bot: { runtime: "codex", runtimeConfigRevision: 1 },
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledOnce()
  })

  it("changed model, push transport error: keeps D1 desired state and reports delivery failure", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1",
      runtime: "claude", modelName: "claude-opus-4-6",
    })
    mockPushAgentModelSwitchToMachine.mockResolvedValue({ sent: 0, deliveryError: true })
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      deliveryError: true,
      application: "saved_not_applied",
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledOnce()
  })

  it("changed model, desired-state write throws: logs, returns 500, and does not push", async () => {
    mockUpdateBotRuntimeConfig.mockRejectedValue(new Error("d1 down"))
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(500)
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_runtime_switch_persist_failed",
      expect.objectContaining({ botId: "b1", persistErr: expect.stringContaining("d1 down") }),
    )
  })

  it("changed provider, desired-state write throws: logs, returns 500, and does not push", async () => {
    mockUpdateBotRuntimeConfig.mockRejectedValue(new Error("d1 down"))
    const res = await PATCH(patchReq({ runtime: "codex" }), ctx)
    expect(res.status).toBe(500)
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_runtime_switch_persist_failed",
      expect.objectContaining({ botId: "b1" }),
    )
  })

  it("model PATCH on a bot with no binding row returns 409 before push", async () => {
    mockUpdateBotRuntimeConfig.mockResolvedValue(false)
    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(409)
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()
  })

  it("same model / omitted model: no push, column untouched", async () => {
    let res = await PATCH(patchReq({ model: null }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
    expect(mockPushAgentModelSwitchToMachine).not.toHaveBeenCalled()

    vi.clearAllMocks()
    mockGetBotOwnedBy.mockResolvedValue({ id: "b1", name: "Old", description: "d", machineId: "mac1", ownerUserId: "u1", runtime: "claude", modelName: null })
    mockUpdateBot.mockResolvedValue({ id: "b1", name: "New", discriminator: "0001", description: "d", image: null })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
    res = await PATCH(patchReq({ name: "New" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
  })

  it("model:null on a bot that had one: persists Default then pushes with from/to", async () => {
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
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "claude",
      modelName: null,
      reasoningEffort: null,
    })
  })

  it("name AND model changed: both bot:updated and model_switch are pushed", async () => {
    const res = await PATCH(patchReq({ name: "New", model: "claude-sonnet-4-6" }), ctx)
    expect(res.status).toBe(200)
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(expect.anything(), "mac1", expect.objectContaining({ type: "bot:updated" }))
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalled()
  })

  it("runtime not on machine → 400", async () => {
    const res = await PATCH(patchReq({ runtime: "unknown-runtime" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
    expect(mockPushAgentProviderSwitchToMachine).not.toHaveBeenCalled()
  })

  it("persists and forwards a supported reasoning-only edit with a server revision", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "codex", modelName: "gpt-5", reasoningEffort: null, runtimeConfigRevision: 3,
    })
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "codex",
        status: "healthy",
        reasoning: {
          updateMode: "live_next_turn",
          defaultModelId: "gpt-5",
          models: [{
            id: "gpt-5",
            supportedReasoningEfforts: [{ value: "minimal" }, { value: "xhigh" }],
            defaultReasoningEffort: "minimal",
          }],
        },
      }],
    })
    mockUpdateBotRuntimeConfig.mockResolvedValue({ runtimeConfigRevision: 4 })

    const res = await PATCH(patchReq({ reasoningEffort: "xhigh" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: true,
      application: "next_turn",
      bot: { reasoningEffort: "xhigh", runtimeConfigRevision: 4 },
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "codex",
      modelName: "gpt-5",
      reasoningEffort: "xhigh",
    })
    expect(mockPushAgentRuntimeConfigUpdateToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({
        agentId: "b1",
        config: expect.objectContaining({ reasoningEffort: "xhigh", runtimeConfigRevision: 4 }),
      }),
    )
  })

  it("rejects a forged unsupported explicit effort without writing or forwarding", async () => {
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "claude",
        status: "healthy",
        reasoning: {
          updateMode: "context_preserving_restart",
          defaultModelId: "default",
          models: [{ id: "default", supportedReasoningEfforts: [{ value: "low" }] }],
        },
      }],
    })

    const res = await PATCH(patchReq({ reasoningEffort: "ultra" }), ctx)

    expect(res.status).toBe(400)
    expect(mockUpdateBotRuntimeConfig).not.toHaveBeenCalled()
    expect(mockPushAgentRuntimeConfigUpdateToMachine).not.toHaveBeenCalled()
  })

  it("persists an offline reasoning edit and sends no control frame", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "codex", modelName: "gpt-5", reasoningEffort: null, runtimeConfigRevision: 3,
    })
    mockIsBotOnline.mockResolvedValue(false)
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "codex",
        status: "healthy",
        reasoning: {
          updateMode: "live_next_turn",
          models: [{ id: "gpt-5", supportedReasoningEfforts: [{ value: "high" }] }],
        },
      }],
    })
    mockUpdateBotRuntimeConfig.mockResolvedValue({ runtimeConfigRevision: 4 })

    const res = await PATCH(patchReq({ reasoningEffort: "high" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      deliveryError: false,
      application: "saved_not_applied",
      bot: { reasoningEffort: "high", runtimeConfigRevision: 4 },
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledOnce()
    expect(mockPushAgentRuntimeConfigUpdateToMachine).not.toHaveBeenCalled()
  })

  it("returns 500 when a reasoning-only tuple cannot be persisted", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "codex", modelName: "gpt-5", reasoningEffort: null, runtimeConfigRevision: 3,
    })
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "codex",
        status: "healthy",
        reasoning: {
          updateMode: "live_next_turn",
          models: [{ id: "gpt-5", supportedReasoningEfforts: [{ value: "high" }] }],
        },
      }],
    })
    mockUpdateBotRuntimeConfig.mockRejectedValue(new Error("d1 unavailable"))

    const res = await PATCH(patchReq({ reasoningEffort: "high" }), ctx)

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: "failed to persist reasoning effort" })
    expect(mockPushAgentRuntimeConfigUpdateToMachine).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "bot_reasoning_effort_persist_failed",
      expect.objectContaining({ botId: "b1" }),
    )
  })

  it("keeps a persisted reasoning edit recoverable when live delivery throws", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "codex", modelName: "gpt-5", reasoningEffort: null, runtimeConfigRevision: 3,
    })
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "codex",
        status: "healthy",
        reasoning: {
          updateMode: "live_next_turn",
          models: [{ id: "gpt-5", supportedReasoningEfforts: [{ value: "high" }] }],
        },
      }],
    })
    mockUpdateBotRuntimeConfig.mockResolvedValue({ runtimeConfigRevision: 4 })
    mockPushAgentRuntimeConfigUpdateToMachine.mockRejectedValue(new Error("ws unavailable"))

    const res = await PATCH(patchReq({ reasoningEffort: "high" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      deliveryError: true,
      application: "saved_not_applied",
      bot: { reasoningEffort: "high", runtimeConfigRevision: 4 },
    })
  })

  it("keeps a persisted model switch recoverable when delivery throws", async () => {
    mockPushAgentModelSwitchToMachine.mockRejectedValue(new Error("ws unavailable"))

    const res = await PATCH(patchReq({ model: "claude-sonnet-4-6" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      applied: false,
      deliveryError: true,
      application: "saved_not_applied",
    })
  })

  it("falls back to Default when a model switch makes the stored effort incompatible", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1", name: "Old", description: "old desc", machineId: "mac1", ownerUserId: "u1",
      runtime: "codex", modelName: "model-a", reasoningEffort: "high", runtimeConfigRevision: 7,
    })
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{
        id: "codex",
        status: "healthy",
        reasoning: {
          updateMode: "live_next_turn",
          models: [
            { id: "model-a", supportedReasoningEfforts: [{ value: "high" }] },
            { id: "model-b", supportedReasoningEfforts: [{ value: "low" }] },
          ],
        },
      }],
    })
    mockUpdateBotRuntimeConfig.mockResolvedValue({ runtimeConfigRevision: 8 })

    const res = await PATCH(patchReq({ model: "model-b" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      bot: { modelName: "model-b", reasoningEffort: null, runtimeConfigRevision: 8 },
    })
    expect(mockUpdateBotRuntimeConfig).toHaveBeenCalledWith(expect.anything(), "b1", "u1", {
      runtime: "codex",
      modelName: "model-b",
      reasoningEffort: null,
    })
    expect(mockPushAgentModelSwitchToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      expect.objectContaining({ config: expect.not.objectContaining({ reasoningEffort: expect.anything() }) }),
    )
  })
})

describe("DELETE /api/community/bots/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCloudflareContext.mockResolvedValue({ ctx: { waitUntil: mockWaitUntil } })
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1",
      ownerUserId: "u1",
      machineId: "mac1",
    })
    mockListBotServerMemberships.mockResolvedValue(["s1", "s2"])
    mockSoftDeleteBot.mockResolvedValue(true)
    mockMediaDelete.mockResolvedValue(undefined)
    mockPushBotEventToMachine.mockResolvedValue(undefined)
  })

  function deleteReq() {
    return new NextRequest("http://localhost/api/community/bots/b1", { method: "DELETE" })
  }

  it("fails before D1 mutation, WS, daemon, and R2 when ExecutionContext is unavailable", async () => {
    mockGetCloudflareContext.mockRejectedValue(new Error("no context"))

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(500)
    expect(mockSoftDeleteBot).not.toHaveBeenCalled()
    expect(mockMediaDelete).not.toHaveBeenCalled()
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
  })

  it("registers fixed-key cleanup only for the D1 winner, then preserves existing events", async () => {
    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(mockSoftDeleteBot).toHaveBeenCalledWith(expect.anything(), "b1", "u1")
    expect(mockMediaDelete).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockWaitUntil).toHaveBeenCalledOnce()
    expect(mockFanOutToServerMembers).toHaveBeenCalledTimes(2)
    expect(mockFanOutToServerMembers).toHaveBeenCalledWith("s1", {
      type: "community:member.leave",
      serverId: "s1",
      userId: "b1",
    })
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(
      expect.anything(),
      "mac1",
      { type: "bot:removed", botId: "b1" },
    )
    expect(mockMediaDelete.mock.invocationCallOrder[0]!).toBeLessThan(
      mockFanOutToServerMembers.mock.invocationCallOrder[0]!,
    )
  })

  it("cleans the owned immutable child together with the stable alias", async () => {
    mockGetBotOwnedBy.mockResolvedValue({
      id: "b1",
      ownerUserId: "u1",
      machineId: null,
      avatarObjectKey: "bot-avatar/b1/objects/object-7",
    })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(mockMediaDelete).toHaveBeenCalledWith([
      "bot-avatar/b1/objects/object-7",
      "bot-avatar/b1",
    ])
  })

  it("returns 404 with no cleanup or events for an already-deleted loser", async () => {
    mockSoftDeleteBot.mockResolvedValue(false)

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(mockMediaDelete).not.toHaveBeenCalled()
    expect(mockWaitUntil).not.toHaveBeenCalled()
    expect(mockFanOutToServerMembers).not.toHaveBeenCalled()
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
  })

  it("keeps the committed 204 and events when waitUntil throws synchronously", async () => {
    mockWaitUntil.mockImplementation(() => {
      throw new Error("sync waitUntil failure")
    })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(mockMediaDelete).toHaveBeenCalledWith(["bot-avatar/b1"])
    expect(mockFanOutToServerMembers).toHaveBeenCalledTimes(2)
    expect(mockPushBotEventToMachine).toHaveBeenCalledOnce()
  })

  it("keeps the committed 204 when background R2 deletion rejects", async () => {
    mockMediaDelete.mockRejectedValue(new Error("provider secret"))

    const res = await DELETE(deleteReq(), ctx)
    const cleanup = mockWaitUntil.mock.calls[0]![0] as Promise<void>
    await expect(cleanup).resolves.toBeUndefined()

    expect(res.status).toBe(204)
    expect(mockFanOutToServerMembers).toHaveBeenCalledTimes(2)
    expect(mockPushBotEventToMachine).toHaveBeenCalledOnce()
  })
})
