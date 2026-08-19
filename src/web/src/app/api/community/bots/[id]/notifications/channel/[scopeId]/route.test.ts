import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getBotOwnedBy = vi.fn()
const getChannelSetting = vi.fn()
const setChannelLevel = vi.fn()
const removeChannelOverride = vi.fn()
const requireMessageSurfaceAccess = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityBot: { getBotOwnedBy: (...args: unknown[]) => getBotOwnedBy(...args) },
      communityNotificationSetting: {
        getChannelSetting: (...args: unknown[]) => getChannelSetting(...args),
        setChannelLevel: (...args: unknown[]) => setChannelLevel(...args),
        removeChannelOverride: (...args: unknown[]) => removeChannelOverride(...args),
      },
    },
  }
})
vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => requireMessageSurfaceAccess(...args),
}))
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest, ctx: any) => handler(req, {
    env: { DB: {} }, userId: ctx.actor ?? "owner", email: "owner@test", params: ctx.params,
  }),
}))

import { DELETE, PUT } from "./route"

const ctx = { params: { id: "bot_1", scopeId: "dm_1" } } as any
const put = () => new NextRequest("http://local", { method: "PUT", body: JSON.stringify({ level: "mentions" }) })

describe("owner bot channel notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBotOwnedBy.mockResolvedValue({ id: "bot_1", ownerUserId: "owner" })
    requireMessageSurfaceAccess.mockResolvedValue({ ok: true, value: { surface: "dm" } })
    setChannelLevel.mockResolvedValue({ level: "mentions" })
  })

  it("writes the owned bot identity after checking the bot's DM access", async () => {
    const response = await PUT(put(), ctx)
    expect(response.status).toBe(200)
    expect(getBotOwnedBy).toHaveBeenCalledWith({}, "bot_1", "owner")
    expect(requireMessageSurfaceAccess).toHaveBeenCalledWith({}, "dm_1", "bot_1")
    expect(setChannelLevel).toHaveBeenCalledWith({}, {
      userId: "bot_1", channelId: "dm_1", level: "mentions",
    })
  })

  it("masks a non-owned bot and never checks scope", async () => {
    getBotOwnedBy.mockResolvedValue(null)
    const response = await PUT(put(), { ...ctx, actor: "stranger" } as any)
    expect(response.status).toBe(404)
    expect(requireMessageSurfaceAccess).not.toHaveBeenCalled()
    expect(setChannelLevel).not.toHaveBeenCalled()
  })

  it("rejects a bot without target scope access", async () => {
    requireMessageSurfaceAccess.mockResolvedValue({ ok: false, status: 404, error: "not found" })
    const response = await PUT(put(), ctx)
    expect(response.status).toBe(404)
    expect(setChannelLevel).not.toHaveBeenCalled()
  })

  it("uses the same bot access gate before deleting an override", async () => {
    const response = await DELETE(new NextRequest("http://local", { method: "DELETE" }), ctx)
    expect(response.status).toBe(204)
    expect(requireMessageSurfaceAccess).toHaveBeenCalledWith({}, "dm_1", "bot_1")
    expect(removeChannelOverride).toHaveBeenCalledWith({}, { userId: "bot_1", channelId: "dm_1" })
  })
})
