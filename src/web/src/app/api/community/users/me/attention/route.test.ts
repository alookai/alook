import { channelResourceFixture } from "@/test/community-resource-fixtures"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"

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
      communityMessage: { getMessagesByIdsInChannels: vi.fn(async () => []) },
      communityChannel: { listChannelMembershipsForUserInChannels: vi.fn(async () => []) },
      communityUserProfile: { getProfilesByUserIds: vi.fn(async () => []) },
      user: { getUsersByIds: vi.fn(async (_db: unknown, ids: string[]) => ids.map(id => ({ id, name: id === "u2" ? "Alice" : id === "u3" ? "Bob" : id === "peer" ? "Peer" : "Viewer", discriminator: id === "u2" ? "0002" : id === "u3" ? "0003" : "0042", image: id === "u2" ? "/api/community/users/u2/avatar" : null, avatarVersion: id === "u2" ? 7 : 0 }))) },
      communityAttention: {
        getAccountAttentionProjection: (...args: unknown[]) => mocks.snapshot(...args),
      },
    },
    readOrStale: (operation: () => unknown) => Promise.resolve(operation()).then((value) => ({
      value,
      stale: false,
    })),
  }
})
vi.mock("@/lib/community/permissions", () => ({ requireMessageSurfaceAccess: async (_db: unknown, channelId: string) => ({ ok: true, value: { channel: channelResourceFixture({ id: channelId, serverId: null, type: "dm", name: null }) } }) }))
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

  it("exposes exact DM counts for the sole current resource contract", async () => {
    mocks.snapshot.mockResolvedValue({
      scopes: [{ scopeId: "dm1", channelId: "dm1", serverId: null, parentChannelId: null, ordinaryUnread: true, lastUnreadSeq: 5, unreadCount: 2, lastAttentionSeq: null, attentionCount: 0 }],
      items: [], limit: 100, truncated: false,
      included: { servers: [], channels: [], dms: [{ id: "dm1", userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0, lastMessageAt: "2026-10-24T00:00:00Z", lastUnreadSeq: 5 }], profiles: [{ userId: "peer", name: "Peer", discriminator: "0042", avatar: "P", avatarVersion: 0 }], messages: [] },
    })
    const headers = new Headers({ [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) })
    const response = await GET(new Request("http://localhost/api/community/users/me/attention", { headers }) as any)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.scopes[0].unreadCount).toBe(2)
  })

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

    const response = await GET(new Request("http://localhost/api/community/users/me/attention", { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } }) as any)

    await expect(response.json()).resolves.toMatchObject({ scopes: [], items: [] })
    expect(mocks.getPrimaryDb).toHaveBeenCalledWith({ binding: "d1" })
    expect(mocks.snapshot).toHaveBeenCalledWith({ kind: "primary-db" }, "u1", 100)
  })

  it("keeps named summary hints separate from canonical full avatar resources", async () => {
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

    const response = await GET(new Request("http://localhost/api/community/users/me/attention", { headers: { [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } }) as any)
    const body = await response.json()

    expect(body.included.dms[0].avatar).toBe("/api/community/users/u2/avatar")
    expect(body.resources.profiles.find((row: { id: string }) => row.id === "u2")).toMatchObject({ avatar: "/api/community/users/u2/avatar?v=7", avatarVersion: 7 })
    expect(body.resources.profiles.find((row: { id: string }) => row.id === "u3")).toMatchObject({ avatar: null, avatarVersion: 0 })
    expect(body.included.profiles).toEqual([
      expect.objectContaining({
        userId: "u2",
        avatar: "/api/community/users/u2/avatar",
        avatarVersion: 7,
      }),
      expect.objectContaining({ userId: "u3", avatar: "", avatarVersion: 0 }),
    ])
  })
})
