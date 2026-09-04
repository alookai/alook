import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireServerMember = vi.fn()
const setServerLevel = vi.fn()
const broadcastToUserSafe = vi.fn()

vi.mock("@/lib/db", () => ({ getPrimaryDb: () => ({}) }))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => broadcastToUserSafe(...args),
}))
vi.mock("@/lib/community/permissions", () => ({
  requireServerMember: (...args: unknown[]) => requireServerMember(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityNotificationSetting: {
        setServerLevel: (...args: unknown[]) => setServerLevel(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (req: NextRequest, ctx: any) => handler(req, {
    env: { DB: {} },
    userId: "user_1",
    params: ctx.params,
  }),
}))

import { PUT } from "./route"

describe("human server notification settings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireServerMember.mockResolvedValue({ ok: true, member: { id: "member_1" } })
    setServerLevel.mockResolvedValue({
      setting: { level: "nothing" },
      readStateRevision: 7,
    })
    broadcastToUserSafe.mockResolvedValue(undefined)
  })

  it("writes the human policy and broadcasts its committed revision", async () => {
    const response = await PUT(new NextRequest("http://local", {
      method: "PUT",
      body: JSON.stringify({ level: "nothing" }),
    }), { params: { id: "server_1" } } as any)

    expect(response.status).toBe(200)
    expect(setServerLevel).toHaveBeenCalledWith({}, {
      userId: "user_1",
      serverId: "server_1",
      level: "nothing",
      actorKind: "human",
    })
    expect(broadcastToUserSafe).toHaveBeenCalledWith("user_1", {
      type: "community:inbox.changed",
      revision: 7,
      inboxChanged: true,
      reason: "notification_policy",
    })
  })
})
