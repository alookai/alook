import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetMember = vi.fn()
const mockListMemberUserIds = vi.fn()
const mockUpdateServer = vi.fn()
const mockDeleteServerWithMedia = vi.fn()
const mockFanOut = vi.fn()
const mockFanOutToUsers = vi.fn()
const mockScheduleMediaCleanup = vi.fn()
const mockWaitUntil = vi.fn()
const mockGetCloudflareContext = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: (...a: unknown[]) => mockGetCloudflareContext(...a),
}))

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => ({})),
  getPrimaryDb: vi.fn(() => ({})),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityMember: {
        getMember: (...a: unknown[]) => mockGetMember(...a),
        listMemberUserIds: (...a: unknown[]) => mockListMemberUserIds(...a),
      },
      communityServer: {
        updateServer: (...a: unknown[]) => mockUpdateServer(...a),
      },
      communityDeleteMedia: {
        deleteServerWithMedia: (...a: unknown[]) => mockDeleteServerWithMedia(...a),
      },
    },
  }
})

vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
  fanOutToUsers: (...a: unknown[]) => mockFanOutToUsers(...a),
}))

vi.mock("@/lib/community/community-media-cleanup", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/community-media-cleanup")>(
    "@/lib/community/community-media-cleanup",
  )
  return {
    ...actual,
    scheduleCommunityMediaCleanup: (...a: Parameters<typeof actual.scheduleCommunityMediaCleanup>) => {
      mockScheduleMediaCleanup(...a)
      return actual.scheduleCommunityMediaCleanup(...a)
    },
  }
})

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: vi.fn((handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, {
      env: { DB: {}, COMMUNITY_MEDIA: { delete: vi.fn() } },
      userId: "u1",
      email: "u@t.com",
      params,
    })
  }),
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
  }
})

import { DELETE, PATCH } from "./route"

const ctx = { params: { id: "s1" } } as any

function patchReq(body: unknown) {
  return new NextRequest("http://localhost/api/community/servers/s1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  })
}

function deleteReq() {
  return new NextRequest("http://localhost/api/community/servers/s1", { method: "DELETE" })
}

describe("PATCH /api/community/servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockFanOut.mockResolvedValue(undefined)
  })

  it("normalizes a spaced rename via slugify before calling updateServer", async () => {
    mockUpdateServer.mockResolvedValue({ id: "s1", name: "My-Home" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(200)
    expect(mockUpdateServer).toHaveBeenCalledWith(expect.anything(), "s1", { name: "My-Home" })
  })

  it("returns 400 (and never calls updateServer) when the renamed name is all disallowed characters", async () => {
    const res = await PATCH(patchReq({ name: "///" }), ctx)
    expect(res.status).toBe(400)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is not an admin/owner", async () => {
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "member" })

    const res = await PATCH(patchReq({ name: "My Home" }), ctx)
    expect(res.status).toBe(403)
    expect(mockUpdateServer).not.toHaveBeenCalled()
  })
})

describe("DELETE /api/community/servers/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWaitUntil.mockReset()
    mockScheduleMediaCleanup.mockReset()
    mockGetCloudflareContext.mockReset()
    mockGetCloudflareContext.mockResolvedValue({
      env: { DB: {}, COMMUNITY_MEDIA: { delete: vi.fn() } },
      ctx: { waitUntil: mockWaitUntil },
    })
    mockGetMember.mockResolvedValue({ id: "mem_1", userId: "u1", role: "owner" })
    mockListMemberUserIds.mockResolvedValue(["u1", "u2"])
    mockDeleteServerWithMedia.mockResolvedValue({ deleted: true, mediaKeys: [], iconKey: null })
    mockFanOutToUsers.mockResolvedValue(undefined)
  })

  it("snapshots recipients, commits deletion, then broadcasts to every prior member", async () => {
    const order: string[] = []
    mockListMemberUserIds.mockImplementation(async () => {
      order.push("recipients")
      return ["u1", "u2"]
    })
    mockDeleteServerWithMedia.mockImplementation(async () => {
      order.push("delete")
      return { deleted: true, mediaKeys: [], iconKey: null }
    })
    mockFanOutToUsers.mockImplementation(async () => {
      order.push("fanout")
    })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(order).toEqual(["recipients", "delete", "fanout"])
    expect(mockFanOutToUsers).toHaveBeenCalledWith(["u1", "u2"], {
      type: "community:server.delete",
      serverId: "s1",
    })
  })

  it("returns 500 without mutating D1 when execution context acquisition fails", async () => {
    mockGetCloudflareContext.mockRejectedValueOnce(new Error("context unavailable"))

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(500)
    expect(mockDeleteServerWithMedia).not.toHaveBeenCalled()
    expect(mockFanOutToUsers).not.toHaveBeenCalled()
  })

  it("keeps the winner 204 and fanout when waitUntil throws synchronously", async () => {
    mockDeleteServerWithMedia.mockResolvedValue({
      deleted: true,
      mediaKeys: ["channel/s1/a"],
      iconKey: null,
    })
    mockWaitUntil.mockImplementationOnce(() => {
      throw new TypeError("secret registration detail")
    })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(mockDeleteServerWithMedia).toHaveBeenCalledOnce()
    expect(mockFanOutToUsers).toHaveBeenCalledOnce()
  })

  it("schedules attachment and strictly-owned icon cleanup after the winner and before fanout", async () => {
    const order: string[] = []
    mockDeleteServerWithMedia.mockImplementation(async () => {
      order.push("delete")
      return {
        deleted: true,
        mediaKeys: ["channel/s1/a", "channel/s1/a.thumbnail.jpg"],
        iconKey: "server-icon/s1/icon-a",
      }
    })
    mockScheduleMediaCleanup.mockImplementation(() => order.push("cleanup"))
    mockFanOutToUsers.mockImplementation(async () => order.push("fanout"))

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(order).toEqual(["delete", "cleanup", "fanout"])
    expect(mockDeleteServerWithMedia).toHaveBeenCalledWith(expect.anything(), {
      serverId: "s1",
      ownerId: "u1",
    })
    expect(mockScheduleMediaCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ waitUntil: mockWaitUntil }),
      {
        keys: ["channel/s1/a", "channel/s1/a.thumbnail.jpg", "server-icon/s1/icon-a"],
        warning: {
          event: "community_server_media_cleanup_failed",
          fields: { serverId: "s1" },
        },
      },
    )
  })

  it("does not enqueue a legacy or cross-server icon key", async () => {
    mockDeleteServerWithMedia.mockResolvedValue({
      deleted: true,
      mediaKeys: ["channel/s1/a"],
      iconKey: "server-icon/other/icon-a",
    })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(204)
    expect(mockScheduleMediaCleanup).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ keys: ["channel/s1/a"] }),
    )
  })

  it("returns 404 without cleanup or fanout when the owner-scoped delete loses", async () => {
    mockDeleteServerWithMedia.mockResolvedValue({ deleted: false, mediaKeys: [], iconKey: null })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(mockScheduleMediaCleanup).not.toHaveBeenCalled()
    expect(mockFanOutToUsers).not.toHaveBeenCalled()
  })
})
