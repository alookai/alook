import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockSetBotActive = vi.fn()
const mockGetUserPublic = vi.fn()
const mockIsBotOnline = vi.fn()
const mockPushBotEventToMachine = vi.fn()
const mockFanOutPresenceUpdate = vi.fn()
const mockLogWarn = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: { setBotActive: (...args: unknown[]) => mockSetBotActive(...args) },
      communityMachine: { isBotOnline: (...args: unknown[]) => mockIsBotOnline(...args) },
      user: { getUserPublic: (...args: unknown[]) => mockGetUserPublic(...args) },
    },
  }
})
vi.mock("@/lib/community/bot-push", () => ({
  pushBotEventToMachine: (...args: unknown[]) => mockPushBotEventToMachine(...args),
}))
vi.mock("@/lib/community/fanout", () => ({
  fanOutPresenceUpdate: (...args: unknown[]) => mockFanOutPresenceUpdate(...args),
}))
vi.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockLogWarn(...args) } }))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => handler(req, {
    env: { DB: {} },
    userId: "owner_1",
    email: "owner@example.com",
    params: ctx?.params,
  }),
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

const ctx = { params: { id: "bot_1" } } as any
const bot = {
  id: "bot_1",
  ownerUserId: "owner_1",
  machineId: "machine_1",
  name: "Helper",
  discriminator: "0042",
  description: "helps",
  isActive: true,
}

function request(active: unknown) {
  return new NextRequest("http://localhost/api/community/bots/bot_1/active", {
    method: "PATCH",
    body: JSON.stringify({ active }),
  })
}

describe("PATCH /api/community/bots/[id]/active", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserPublic.mockResolvedValue({ name: "Owner", discriminator: "1813" })
    mockIsBotOnline.mockResolvedValue(false)
    mockPushBotEventToMachine.mockResolvedValue({ sent: 1 })
    mockFanOutPresenceUpdate.mockResolvedValue(undefined)
  })

  it("activates an owned bot, pushes it to the daemon, and restores Online when its machine is online", async () => {
    mockSetBotActive.mockResolvedValue({ state: "updated", bot })
    mockIsBotOnline.mockResolvedValue(true)

    const res = await PATCH(request(true), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ bot: { id: "bot_1", isActive: true }, changed: true })
    expect(mockSetBotActive).toHaveBeenCalledWith(expect.anything(), "bot_1", "owner_1", true)
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(expect.anything(), "machine_1", {
      type: "bot:added",
      botId: "bot_1",
      name: "Helper",
      discriminator: "0042",
      description: "helps",
      ownerName: "Owner",
      ownerDiscriminator: "1813",
    })
    expect(mockFanOutPresenceUpdate).toHaveBeenCalledWith("bot_1", true, "owner_1")
  })

  it("deactivates and publishes bot:removed plus Offline", async () => {
    mockSetBotActive.mockResolvedValue({ state: "updated", bot: { ...bot, isActive: false } })

    const res = await PATCH(request(false), ctx)

    expect(res.status).toBe(200)
    expect(mockPushBotEventToMachine).toHaveBeenCalledWith(expect.anything(), "machine_1", {
      type: "bot:removed",
      botId: "bot_1",
    })
    expect(mockFanOutPresenceUpdate).toHaveBeenCalledWith("bot_1", false, "owner_1")
    expect(mockIsBotOnline).not.toHaveBeenCalled()
  })

  it("keeps idempotent requests side-effect free", async () => {
    mockSetBotActive.mockResolvedValue({ state: "unchanged", bot })

    const res = await PATCH(request(true), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ bot: { id: "bot_1", isActive: true }, changed: false })
    expect(mockPushBotEventToMachine).not.toHaveBeenCalled()
    expect(mockFanOutPresenceUpdate).not.toHaveBeenCalled()
  })

  it("returns owner-scoped 404", async () => {
    mockSetBotActive.mockResolvedValue({ state: "not_found" })

    const res = await PATCH(request(true), ctx)

    expect(res.status).toBe(404)
  })

  it("returns plan evidence when the active limit is reached", async () => {
    mockSetBotActive.mockResolvedValue({
      state: "capacity",
      capacity: {
        plan: { id: "free", displayName: "Free" },
        limit: 3,
        ownedCount: 4,
        activeCount: 3,
      },
    })

    const res = await PATCH(request(true), ctx)

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: "BOT_ACTIVE_LIMIT_REACHED",
      plan: "free",
      planDisplayName: "Free",
      limit: 3,
      ownedCount: 4,
      activeCount: 3,
    })
  })

  it("does not turn a committed activation into a 500 when best-effort presence resolution fails", async () => {
    mockSetBotActive.mockResolvedValue({ state: "updated", bot })
    mockIsBotOnline.mockRejectedValue(new Error("D1 unavailable after commit"))

    const res = await PATCH(request(true), ctx)

    expect(res.status).toBe(200)
    expect(mockLogWarn).toHaveBeenCalledWith(
      "bot_activation_post_commit_delivery_failed",
      expect.objectContaining({ botId: "bot_1" }),
    )
  })

  it("rejects a non-boolean activation payload", async () => {
    const res = await PATCH(request("true"), ctx)

    expect(res.status).toBe(400)
    expect(mockSetBotActive).not.toHaveBeenCalled()
  })
})
