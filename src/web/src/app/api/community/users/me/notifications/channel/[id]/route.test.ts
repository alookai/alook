import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireMessageSurfaceAccess = vi.fn()
const setChannelLevel = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => requireMessageSurfaceAccess(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: { communityNotificationSetting: {
      setChannelLevel: (...args: unknown[]) => setChannelLevel(...args),
      removeChannelOverride: vi.fn(),
    } },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest, ctx: any) => handler(req, {
    env: { DB: {} }, userId: "user_1", email: "u@test", params: ctx.params,
  }),
}))

import { PUT } from "./route"

describe("human DM notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMessageSurfaceAccess.mockResolvedValue({ ok: true, value: { surface: "dm" } })
    setChannelLevel.mockResolvedValue({ level: "mentions" })
  })

  it("uses the unified message-surface gate so DM block and participant checks apply", async () => {
    const request = new NextRequest("http://local", {
      method: "PUT",
      body: JSON.stringify({ level: "mentions" }),
    })
    const response = await PUT(request, { params: { id: "dm_1" } } as any)
    expect(response.status).toBe(200)
    expect(requireMessageSurfaceAccess).toHaveBeenCalledWith({}, "dm_1", "user_1")
    expect(setChannelLevel).toHaveBeenCalledWith({}, {
      userId: "user_1", channelId: "dm_1", level: "mentions",
    })
  })
})
