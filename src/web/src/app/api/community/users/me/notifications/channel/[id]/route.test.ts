import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireMessageSurfaceAccess = vi.fn()
const setChannelLevel = vi.fn()
const removeChannelOverride = vi.fn()
const broadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => broadcastToUserSafe(...args),
}))
vi.mock("@/lib/community/permissions", () => ({
  requireMessageSurfaceAccess: (...args: unknown[]) => requireMessageSurfaceAccess(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: { communityNotificationSetting: {
      setChannelLevel: (...args: unknown[]) => setChannelLevel(...args),
      removeChannelOverride: (...args: unknown[]) => removeChannelOverride(...args),
    } },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest, ctx: any) => handler(req, {
    env: { DB: {} }, userId: "user_1", email: "u@test", params: ctx.params,
  }),
}))

import { DELETE, PUT } from "./route"

describe("human DM notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireMessageSurfaceAccess.mockResolvedValue({ ok: true, value: { surface: "dm" } })
    setChannelLevel.mockResolvedValue({
      setting: { level: "mentions" },
      readStateRevision: 2,
    })
    broadcastToUserSafe.mockResolvedValue(undefined)
    removeChannelOverride.mockResolvedValue({
      setting: null,
      readStateRevision: 3,
    })
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
      userId: "user_1", channelId: "dm_1", level: "mentions", actorKind: "human",
    })
    expect(broadcastToUserSafe).toHaveBeenCalledWith("user_1", {
      type: "community:inbox.changed",
      revision: 2,
      inboxChanged: true,
      reason: "notification_policy",
    })
  })

  it("removes a human override through the same gate and broadcasts its revision", async () => {
    const response = await DELETE(
      new NextRequest("http://local", { method: "DELETE" }),
      { params: { id: "dm_1" } } as any,
    )

    expect(response.status).toBe(204)
    expect(removeChannelOverride).toHaveBeenCalledWith({}, {
      userId: "user_1",
      channelId: "dm_1",
      actorKind: "human",
    })
    expect(broadcastToUserSafe).toHaveBeenCalledWith("user_1", {
      type: "community:inbox.changed",
      revision: 3,
      inboxChanged: true,
      reason: "notification_policy",
    })
  })
})
