import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockMarkAllServerChannelsRead = vi.fn()
const mockListVisibleChannelIds = vi.fn()
const mockBroadcastToUserSafe = vi.fn()
const mockGetPrimaryDb = vi.fn(() => ({ kind: "primary-db" }))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => ({ env: { DB: {} } })),
}))

vi.mock("@/lib/db", () => ({
  getPrimaryDb: (...args: unknown[]) => mockGetPrimaryDb(...args),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityReadState: {
        ...actual.queries.communityReadState,
        markAllServerChannelsRead: (...args: unknown[]) => mockMarkAllServerChannelsRead(...args),
      },
      communityChannel: {
        ...actual.queries.communityChannel,
        listVisibleChannelIdsForUser: (...args: unknown[]) => mockListVisibleChannelIds(...args),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: (...args: unknown[]) => mockBroadcastToUserSafe(...args),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { POST } from "./route"

describe("POST /api/community/users/me/inbox/unreads/read-all", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListVisibleChannelIds.mockResolvedValue(["c1", "c2"])
    mockBroadcastToUserSafe.mockResolvedValue(undefined)
  })

  it("returns the count of NON-EMPTY channels marked read (invariant: empty channels excluded)", async () => {
    // Post-invariant: count == channels that actually received an aligned
    // write. Empty channels are skipped, so this is <= reachable-channel count.
    const advances = [{
      channelId: "c1",
      lastReadMessageId: "m3",
      lastReadAt: "2026-08-24T00:00:03.000Z",
      lastReadSeq: 3,
    }]
    mockMarkAllServerChannelsRead.mockResolvedValue({ count: 7, revision: 3, advances })
    const res = await POST(new NextRequest("http://localhost/api/community/users/me/inbox/unreads/read-all", { method: "POST" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, count: 7, revision: 3 })
    // Scoped to the viewer's visible channels (resolved once, passed through).
    expect(mockMarkAllServerChannelsRead).toHaveBeenCalledWith(
      { kind: "primary-db" },
      "u1",
      ["c1", "c2"],
    )
    expect(mockBroadcastToUserSafe).toHaveBeenCalledWith("u1", {
      type: "community:inbox.changed",
      revision: 3,
      advances,
      inboxChanged: true,
      reason: "read_all",
    })
    expect(mockGetPrimaryDb).toHaveBeenCalledOnce()
  })

  it("returns count 0 when every channel is empty (nothing to write)", async () => {
    mockMarkAllServerChannelsRead.mockResolvedValue({ count: 0, revision: null, advances: [] })
    const res = await POST(new NextRequest("http://localhost/api/community/users/me/inbox/unreads/read-all", { method: "POST" }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, count: 0, revision: null })
    expect(mockBroadcastToUserSafe).not.toHaveBeenCalled()
  })
})
