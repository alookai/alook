import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockCountLiveBotsForOwner = vi.fn()
const mockGetMachineForOwner = vi.fn()
const mockCreateBot = vi.fn()
const mockGetUserPublic = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockListBotsForOwner = vi.fn()
const mockGetBotDailyActivityForOwner = vi.fn()
const mockEnsureSiblingBotFriendship = vi.fn()

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
        listBotsForOwner: (...a: unknown[]) => mockListBotsForOwner(...a),
        getBotDailyActivityForOwner: (...a: unknown[]) => mockGetBotDailyActivityForOwner(...a),
      },
      communityFriendship: {
        ensureSiblingBotFriendship: (...a: unknown[]) => mockEnsureSiblingBotFriendship(...a),
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

import { GET, POST } from "./route"

function getReq() {
  return new NextRequest("http://localhost/api/community/bots", { method: "GET" })
}

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
      availableRuntimes: [{ id: "claude", status: "healthy" }, { id: "codex", status: "healthy" }],
    })
    mockCreateBot.mockResolvedValue({ botId: "b1", name: "MyBot", discriminator: "0001", description: "", image: null })
    mockGetUserPublic.mockResolvedValue({ id: "u1", name: "Owner", discriminator: "9999" })
    mockListBotsForOwner.mockResolvedValue([{ id: "b1" }])
    mockEnsureSiblingBotFriendship.mockResolvedValue({ blocked: false })
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

  it("keeps same-owner sibling auto-friendship after removing server audit writes", async () => {
    mockListBotsForOwner.mockResolvedValue([{ id: "b1" }, { id: "b2" }])

    const res = await POST(postReq(base()), ctx)

    expect(res.status).toBe(201)
    expect(mockEnsureSiblingBotFriendship).toHaveBeenCalledOnce()
    expect(mockEnsureSiblingBotFriendship).toHaveBeenCalledWith(
      expect.anything(),
      { botA: "b1", botB: "b2" },
    )
  })

  it("still returns 201 when sibling auto-friendship fails", async () => {
    mockListBotsForOwner.mockResolvedValue([{ id: "b1" }, { id: "b2" }])
    mockEnsureSiblingBotFriendship.mockRejectedValue(new Error("D1 unavailable"))

    const res = await POST(postReq(base()), ctx)

    expect(res.status).toBe(201)
    expect(mockPushBotEventToMachine).toHaveBeenCalledOnce()
  })

  it("rejects a removed runtime that is absent from the machine report with 400", async () => {
    const res = await POST(postReq(base(undefined, "gemini")), ctx)
    expect(res.status).toBe(400)
    expect(mockCreateBot).not.toHaveBeenCalled()
  })
})

describe("GET /api/community/bots — heatmap activity", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("attaches each bot's 30-day dailyActivity from the batched owner read", async () => {
    mockListBotsForOwner.mockResolvedValue([
      { id: "bot_1", name: "A", machineId: "m1", runtime: "claude", modelName: null },
      { id: "bot_2", name: "B", machineId: "m1", runtime: "claude", modelName: null },
    ])
    const byBot = new Map<string, unknown[]>([
      ["bot_1", [{ day: "2026-07-31", handledCount: 3, sentCount: 1 }]],
    ])
    mockGetBotDailyActivityForOwner.mockResolvedValue(byBot)

    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { bots: Array<{ id: string; dailyActivity: unknown[] }> }
    // bot_1 gets its rows; bot_2 (absent from the map) defaults to [] — the
    // normal new-bot path, not an error.
    expect(body.bots.find((b) => b.id === "bot_1")?.dailyActivity).toEqual([
      { day: "2026-07-31", handledCount: 3, sentCount: 1 },
    ])
    expect(body.bots.find((b) => b.id === "bot_2")?.dailyActivity).toEqual([])
    // Scoped to the caller (u1) and a 30-day (29-days-ago) window.
    expect(mockGetBotDailyActivityForOwner).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    )
  })

  it("returns an empty bots array when the owner has none", async () => {
    mockListBotsForOwner.mockResolvedValue([])
    mockGetBotDailyActivityForOwner.mockResolvedValue(new Map())
    const res = await GET(getReq(), ctx)
    expect(res.status).toBe(200)
    expect((await res.json()) as { bots: unknown[] }).toEqual({ bots: [] })
  })
})
