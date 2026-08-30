import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  actors: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }))
vi.mock("@/lib/community/reaction-access", () => ({
  authorizeReaction: (...args: unknown[]) => mocks.authorize(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReaction: {
        ...actual.queries.communityReaction,
        getReactionDetailsActors: (...args: unknown[]) => mocks.actors(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: Function) => async (req: NextRequest, ctx: { params: { id: string } }) => {
    const bot = req.headers.get("authorization")?.startsWith("Bearer crk_")
    return handler(req, {
      env: { DB: {} },
      params: ctx.params,
      actor: bot
        ? { kind: "bot", userId: "bot_1", ownerUserId: "u1", machineId: "machine_1" }
        : { kind: "human", userId: "viewer_1", email: "viewer@example.com" },
    })
  },
}))

import { GET } from "./route"

const context = { params: { id: "message_1" } } as never
const request = (bot = false) => new NextRequest(
  "http://localhost/api/community/messages/message_1/reactions",
  bot ? { headers: { authorization: "Bearer crk_test" } } : undefined,
)

describe("GET reaction details", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authorize.mockResolvedValue({
      ok: true,
      channelId: "channel_1",
      isDm: false,
      scope: { kind: "server", serverId: "server_1", channelId: "channel_1" },
    })
    mocks.actors.mockResolvedValue([])
  })

  it("authorizes before one message-scoped actor query and preserves nullable identities", async () => {
    mocks.actors.mockResolvedValue([
      {
        userId: "user_1",
        profile: {
          id: "user_1",
          name: "Alice",
          discriminator: "0042",
          image: "/api/community/users/user_1/avatar",
          avatarVersion: 7,
        },
      },
      { userId: "departed_1", profile: null },
    ])

    const response = await GET(request(), context)
    expect(response.status).toBe(200)
    expect(mocks.authorize).toHaveBeenCalledWith({}, "message_1", "viewer_1")
    expect(mocks.actors).toHaveBeenCalledOnce()
    expect(mocks.actors).toHaveBeenCalledWith(
      {},
      "message_1",
      { kind: "server", serverId: "server_1", channelId: "channel_1" },
    )
    await expect(response.json()).resolves.toMatchObject({
      messageId: "message_1",
      actors: [
        { userId: "user_1", profile: { avatar: "/api/community/users/user_1/avatar?v=7" } },
        { userId: "departed_1", profile: null },
      ],
    })
  })

  it("does not run actor SQL when authorization fails", async () => {
    mocks.authorize.mockResolvedValue({ ok: false, error: "message not found", status: 404 })
    const response = await GET(request(), context)
    expect(response.status).toBe(404)
    expect(mocks.actors).not.toHaveBeenCalled()
  })

  it("rejects bot credentials before authorization or actor SQL", async () => {
    const response = await GET(request(true), context)
    expect(response.status).toBe(401)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.actors).not.toHaveBeenCalled()
  })

  it("derives a stable avatar fallback inside the authorized profile", async () => {
    mocks.actors.mockResolvedValue([{
      userId: "user_1",
      profile: {
        id: "user_1",
        name: "Alice",
        discriminator: "0042",
        image: null,
        avatarVersion: 0,
      },
    }])
    const response = await GET(request(), context)
    await expect(response.json()).resolves.toMatchObject({
      actors: [{ userId: "user_1", profile: { avatar: "A" } }],
    })
  })
})
