import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const r2Get = vi.fn()
const getSession = vi.fn()
const getChannelForMember = vi.fn()
const getDM = vi.fn()
const isBlocked = vi.fn()

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({
    env: {
      DB: {},
      CACHE_KV: null,
      COMMUNITY_MEDIA: { get: (...a: unknown[]) => r2Get(...a) },
    },
  })),
}))

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/cache", () => ({ bindCacheKV: vi.fn() }))

vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: (...a: unknown[]) => getSession(...a) },
  })),
}))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityChannel: { getChannelForMember: (...a: unknown[]) => getChannelForMember(...a) },
      communityDm: { getDM: (...a: unknown[]) => getDM(...a) },
      communityFriendship: { isBlocked: (...a: unknown[]) => isBlocked(...a) },
    },
  }
})

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function call(segments: string[]) {
  return GET(
    new NextRequest("http://localhost/api/community/media/" + segments.join("/"), {
      method: "GET",
    }),
    { params: Promise.resolve({ key: segments }) },
  )
}

describe("GET /api/community/media/[...key]", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSession.mockResolvedValue({ user: { id: "u1" } })
    isBlocked.mockResolvedValue(false)
    r2Get.mockResolvedValue({
      body: new ReadableStream(),
      httpMetadata: { contentType: "image/png" },
    })
  })

  it("returns 401 when there is no authenticated session", async () => {
    getSession.mockResolvedValue(null)
    const res = await call(["channel", "c1", "f1", "x.png"])
    expect(res.status).toBe(401)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("returns 400 when any segment is `..` (path traversal)", async () => {
    const res = await call(["channel", "..", "f1", "x.png"])
    expect(res.status).toBe(400)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("returns 400 when any segment contains a slash", async () => {
    const res = await call(["channel", "c1/extra", "f1", "x.png"])
    // NextRequest may collapse multi-slash routes; just guard the unit
    // contract by passing segments directly.
    expect(res.status).toBe(400)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("returns 403 when the caller is not a member of the channel", async () => {
    getChannelForMember.mockResolvedValue(null)
    const res = await call(["channel", "c1", "f1", "x.png"])
    expect(res.status).toBe(403)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("serves a channel attachment when the caller is a member", async () => {
    getChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    const res = await call(["channel", "c1", "f1", "x.png"])
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(res.headers.get("Content-Disposition")).toBe("inline")
    expect(r2Get).toHaveBeenCalledWith("channel/c1/f1/x.png")
  })

  it("returns 403 when the caller is not a DM participant", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "ux", user2Id: "uy", lastMessageAt: null, createdAt: "" })
    const res = await call(["dm", "d1", "f1", "x.png"])
    expect(res.status).toBe(403)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("returns 404 when the DM does not exist", async () => {
    getDM.mockResolvedValue(null)
    const res = await call(["dm", "d1", "f1", "x.png"])
    expect(res.status).toBe(404)
  })

  it("returns 403 when the caller is blocked by the DM counterpart", async () => {
    // Behaviour change: previously the DM branch skipped the block check and
    // would happily serve the bytes. Folding the block into
    // `requireDMParticipant` closes that gap.
    getDM.mockResolvedValue({ id: "d1", user1Id: "u1", user2Id: "u2", lastMessageAt: null, createdAt: "" })
    isBlocked.mockResolvedValue(true)
    const res = await call(["dm", "d1", "f1", "x.png"])
    expect(res.status).toBe(403)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("serves a DM attachment when the caller participates and isn't blocked", async () => {
    getDM.mockResolvedValue({ id: "d1", user1Id: "u1", user2Id: "u2", lastMessageAt: null, createdAt: "" })
    isBlocked.mockResolvedValue(false)
    const res = await call(["dm", "d1", "f1", "x.png"])
    expect(res.status).toBe(200)
    expect(r2Get).toHaveBeenCalledWith("dm/d1/f1/x.png")
  })

  it("serves a server-icon to any authenticated user (no membership check)", async () => {
    const res = await call(["server-icon", "s1", "f1"])
    expect(res.status).toBe(200)
    expect(getChannelForMember).not.toHaveBeenCalled()
    expect(getDM).not.toHaveBeenCalled()
  })

  it("returns 404 for unknown resource kinds", async () => {
    const res = await call(["secret", "s1", "x"])
    expect(res.status).toBe(404)
    expect(r2Get).not.toHaveBeenCalled()
  })

  it("sets attachment Content-Disposition for non-image content types", async () => {
    getChannelForMember.mockResolvedValue({ id: "c1", serverId: "s1" })
    r2Get.mockResolvedValue({
      body: new ReadableStream(),
      httpMetadata: { contentType: "application/pdf" },
    })
    const res = await call(["channel", "c1", "f1", "spec.pdf"])
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="spec.pdf"')
  })
})
