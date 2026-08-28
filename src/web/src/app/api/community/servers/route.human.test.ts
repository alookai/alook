import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  listUserServers: vi.fn(),
  listEligibleUnreadServerIds: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({ kind: "db" })) }))
vi.mock("@/lib/community/storage", () => ({
  serverIconUrl: vi.fn((row: { icon?: string | null }) => row.icon ?? null),
}))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: (...args: any[]) => unknown) =>
    (req: NextRequest) => handler(req, {
      env: { DB: {} },
      actor: { kind: "human", userId: "viewer", email: "viewer@example.test" },
    }),
  rejectBot: vi.fn(() => null),
}))
vi.mock("@/lib/middleware/helpers", () => ({
  writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
  writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityServer: {
        ...actual.queries.communityServer,
        listUserServers: (...args: unknown[]) => mocks.listUserServers(...args),
      },
      communityInbox: {
        ...actual.queries.communityInbox,
        listEligibleUnreadServerIds: (...args: unknown[]) => mocks.listEligibleUnreadServerIds(...args),
      },
    },
  }
})

import { GET } from "./route"

describe("GET /api/community/servers — human unread seed", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listUserServers.mockResolvedValue([
      { id: "server-a", name: "A", icon: null },
      { id: "server-b", name: "B", icon: null },
    ])
  })

  it("adds an explicit boolean to every human row from one unread-id scan", async () => {
    mocks.listEligibleUnreadServerIds.mockResolvedValue(["server-b"])

    const response = await GET(new NextRequest("http://localhost/api/community/servers"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      servers: [
        { id: "server-a", name: "A", icon: null, unread: false },
        { id: "server-b", name: "B", icon: null, unread: true },
      ],
    })
    expect(mocks.listEligibleUnreadServerIds).toHaveBeenCalledTimes(1)
    expect(mocks.listEligibleUnreadServerIds).toHaveBeenCalledWith(expect.anything(), "viewer")
  })

  it("fails the human canonical response when its unread source fails", async () => {
    mocks.listEligibleUnreadServerIds.mockRejectedValue(new Error("unread failed"))

    await expect(GET(new NextRequest("http://localhost/api/community/servers")))
      .rejects.toThrow("unread failed")
  })
})
