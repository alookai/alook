import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockCountLiveBotsForOwner = vi.fn()
const mockGetMachineForOwner = vi.fn()
const mockCreateBot = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
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
        countLiveBotsForOwner: (...a: unknown[]) => mockCountLiveBotsForOwner(...a),
        getMachineForOwner: (...a: unknown[]) => mockGetMachineForOwner(...a),
        createBot: (...a: unknown[]) => mockCreateBot(...a),
      },
      user: {
        getUserPublic: (...a: unknown[]) => mockGetUserPublic(...a),
      },
    },
  }
})

vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...a: unknown[]) => mockPushBotEventToMachine(...a),
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

import { POST } from "./route"

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/bots", {
    method: "POST",
    body: JSON.stringify(body),
  })
}
const ctx = {} as any

function base(model?: unknown, runtime = "claude") {
  return {
    name: "MyBot",
    machineId: "mac1",
    runtime,
    ...(model !== undefined ? { model } : {}),
  }
}

describe("POST /api/community/bots — model", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCountLiveBotsForOwner.mockResolvedValue(0)
    mockGetMachineForOwner.mockResolvedValue({
      id: "mac1",
      availableRuntimes: [{ id: "claude", status: "healthy" }, { id: "antigravity", status: "healthy" }],
    })
    mockCreateBot.mockResolvedValue({ botId: "b1", name: "MyBot", discriminator: "0001", description: "", image: null })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
  })

  it("persists model_name and returns it in the 201 body", async () => {
    const res = await POST(postReq(base("claude-opus-4-6")), ctx)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { bot: { modelName: string | null } }
    expect(body.bot.modelName).toBe("claude-opus-4-6")
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelName: "claude-opus-4-6" }),
    )
  })

  it("omitting model leaves modelName null", async () => {
    const res = await POST(postReq(base()), ctx)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { bot: { modelName: string | null } }
    expect(body.bot.modelName).toBeNull()
    expect(mockCreateBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelName: null }),
    )
  })

  it("rejects a model on runtime antigravity with 400", async () => {
    const res = await POST(postReq(base("some-model", "antigravity")), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateBot).not.toHaveBeenCalled()
  })
})
