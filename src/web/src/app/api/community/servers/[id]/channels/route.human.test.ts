import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockListServerChannelsForViewer = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMember: { getMember: (...args: unknown[]) => mockGetMember(...args) },
      communityChannel: {
        ...actual.queries.communityChannel,
        listServerChannelsForViewer: (...args: unknown[]) => mockListServerChannelsForViewer(...args),
      },
    },
  }
})
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => async (req: any, ctx: any) => handler(req, {
    env: { DB: {} },
    actor: { kind: "human", userId: "user_1", email: "u@example.com" },
    params: ctx.params,
  }),
}))

import { GET } from "./route"

describe("GET /api/community/servers/[id]/channels — human resource", () => {
  it("returns only viewer-visible channel rows after one server membership gate", async () => {
    mockGetMember.mockResolvedValue({ id: "member_1", role: "member" })
    mockListServerChannelsForViewer.mockResolvedValue([{ id: "channel_1", serverId: "server_1", name: "general" }])
    const response = await GET(
      new NextRequest("http://localhost/api/community/servers/server_1/channels"),
      { params: { id: "server_1" } } as never,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ channels: [{ id: "channel_1", serverId: "server_1", name: "general" }] })
    expect(mockListServerChannelsForViewer).toHaveBeenCalledWith(expect.anything(), "server_1", "user_1")
  })
})
