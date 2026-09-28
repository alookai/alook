import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  getPrimaryDb: vi.fn(() => ({ kind: "primary-db" })),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: (...args: unknown[]) => mocks.getPrimaryDb(...args),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityAttention: {
        getAccountAttentionSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
      },
    },
    readOrStale: (operation: () => unknown) => Promise.resolve(operation()).then((value) => ({
      value,
      stale: false,
    })),
  }
})
vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => (request: any) => handler(request, {
    env: { DB: { binding: "d1" } },
    userId: "u1",
  }),
}))
vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown) => Response.json(data),
}))

import { GET } from "./route"

describe("GET /api/community/users/me/attention", () => {
  beforeEach(() => vi.clearAllMocks())

  it("uses the primary-authoritative session for the stateless snapshot", async () => {
    mocks.snapshot.mockResolvedValue({
      scopes: [],
      items: [],
      limit: 100,
      truncated: false,
      included: {
        servers: [], channels: [], dms: [], profiles: [], messages: [],
      },
    })

    const response = await GET(new Request("http://localhost/api/community/users/me/attention") as any)

    await expect(response.json()).resolves.toMatchObject({ scopes: [], items: [] })
    expect(mocks.getPrimaryDb).toHaveBeenCalledWith({ binding: "d1" })
    expect(mocks.snapshot).toHaveBeenCalledWith({ kind: "primary-db" }, "u1", 100)
  })

  it("returns the same canonical avatar contract for included DMs and profiles", async () => {
    mocks.snapshot.mockResolvedValue({
      scopes: [{
        scopeId: "dm1",
        channelId: "dm1",
        serverId: null,
        parentChannelId: null,
        ordinaryUnread: true,
        lastUnreadSeq: 3,
        lastAttentionSeq: null,
        attentionCount: 0,
      }],
      items: [],
      limit: 100,
      truncated: false,
      included: {
        servers: [],
        channels: [],
        dms: [{
          id: "dm1",
          userId: "u2",
          name: "Alice",
          discriminator: "0002",
          avatar: "/api/community/users/u2/avatar",
          avatarVersion: 7,
          lastMessageAt: "2026-09-28T00:00:00.000Z",
          lastUnreadSeq: 3,
        }],
        profiles: [{
          userId: "u2",
          name: "Alice",
          discriminator: "0002",
          avatar: "/api/community/users/u2/avatar",
          avatarVersion: 7,
        }, {
          userId: "u3",
          name: "Bob",
          discriminator: "0003",
          avatar: "",
          avatarVersion: 0,
        }],
        messages: [],
      },
    })

    const response = await GET(new Request("http://localhost/api/community/users/me/attention") as any)
    const body = await response.json()

    expect(body.included.dms[0].avatar).toBe("/api/community/users/u2/avatar?v=7")
    expect(body.included.profiles).toEqual([
      expect.objectContaining({
        userId: "u2",
        avatar: "/api/community/users/u2/avatar?v=7",
        avatarVersion: 7,
      }),
      expect.objectContaining({ userId: "u3", avatar: "B", avatarVersion: 0 }),
    ])
  })
})
