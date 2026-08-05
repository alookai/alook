import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

const mockGetInviteByToken = vi.fn()
const mockGetServer = vi.fn()
const mockCountMembers = vi.fn()
const mockListMembers = vi.fn()
const mockGetUsersByIds = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityInvite: {
        getInviteByToken: (...a: unknown[]) => mockGetInviteByToken(...a),
      },
      communityServer: {
        getServer: (...a: unknown[]) => mockGetServer(...a),
      },
      communityMember: {
        countMembers: (...a: unknown[]) => mockCountMembers(...a),
        listMembers: (...a: unknown[]) => mockListMembers(...a),
      },
      user: {
        getUsersByIds: (...a: unknown[]) => mockGetUsersByIds(...a),
      },
    },
  }
})

// The route is `withOptionalAuth` (preview-first): it NEVER 401s on a missing
// session — the handler runs either way, only `userId` differs. Two shapes:
//   * `authed`     — the default: handler runs with a userId, as if signed in.
//   * `anonymous`  — handler still runs, with userId undefined (no 401).
// The mock is `let`-mutated between blocks so we can flip the behaviour per
// test.
let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withOptionalAuth: (handler: any) => async (req: any, ctx?: any) => {
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return isAuthed
      ? handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
      : handler(req, { env: { DB: {} }, params })
  },
}))

vi.mock("@/lib/middleware/helpers", () => {
  const { NextResponse } = require("next/server")
  return {
    writeJSON: (data: unknown, status = 200) => NextResponse.json(data, { status }),
    writeError: (message: string, status: number) => NextResponse.json({ error: message }, { status }),
  }
})

import { GET } from "./route"

function req() {
  return new NextRequest("http://localhost/api/community/invites/tok_1/info", { method: "GET" })
}

function ctx() {
  return { params: Promise.resolve({ token: "tok_1" }) } as any
}

describe("GET /api/community/invites/[token]/info", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthed = true
    mockGetInviteByToken.mockResolvedValue({
      id: "inv_1",
      serverId: "s1",
      createdBy: "u_inviter",
      expiresAt: null,
      maxUses: null,
      uses: 0,
    })
    mockGetServer.mockResolvedValue({
      id: "s1",
      name: "Server One",
      icon: null,
      description: "A place",
    })
    mockCountMembers.mockResolvedValue(3)
    mockListMembers.mockResolvedValue([])
    mockGetUsersByIds.mockResolvedValue([{ id: "u_inviter", name: "Gus", image: null }])
  })

  it("returns memberCount resolved via countMembers", async () => {
    mockCountMembers.mockResolvedValue(42)

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    const body = await res.json() as { memberCount: number }
    expect(body.memberCount).toBe(42)

    expect(mockCountMembers).toHaveBeenCalledTimes(1)
    expect(mockCountMembers).toHaveBeenCalledWith(expect.anything(), "s1")
  })

  it("serves anonymous callers the same payload (preview-first, no 401)", async () => {
    isAuthed = false
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    // Token is still the capability — the handler ran and resolved the invite.
    expect(mockGetInviteByToken).toHaveBeenCalledWith(expect.anything(), "tok_1")
    const body = await res.json() as { serverName: string }
    expect(body.serverName).toBe("Server One")
  })

  it("still rejects an invalid token for anonymous callers (token gate intact)", async () => {
    isAuthed = false
    mockGetInviteByToken.mockResolvedValue(null)
    const res = await GET(req(), ctx())
    expect(res.status).toBe(404)
  })

  it("exposes serverDescription for the landing page", async () => {
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as { serverDescription: string; serverName: string }
    expect(body.serverDescription).toBe("A place")
    expect(body.serverName).toBe("Server One")
  })

  it("defaults serverDescription to empty string when the server has none", async () => {
    mockGetServer.mockResolvedValue({ id: "s1", name: "Server One", icon: null, description: null })
    const res = await GET(req(), ctx())
    const body = await res.json() as { serverDescription: string }
    expect(body.serverDescription).toBe("")
  })

  it("resolves the inviter from invite.createdBy", async () => {
    mockGetUsersByIds.mockResolvedValue([{ id: "u_inviter", name: "Gus", image: "user-avatar/u_inviter" }])
    const res = await GET(req(), ctx())
    const body = await res.json() as { inviter: { name: string; avatar: string } | null }
    expect(mockGetUsersByIds).toHaveBeenCalledWith(expect.anything(), ["u_inviter"])
    expect(body.inviter).toEqual({ id: "u_inviter", name: "Gus", avatar: "user-avatar/u_inviter" })
  })

  it("returns inviter=null when createdBy is null (pruned/legacy invite)", async () => {
    mockGetInviteByToken.mockResolvedValue({
      id: "inv_1", serverId: "s1", createdBy: null, expiresAt: null, maxUses: null, uses: 0,
    })
    const res = await GET(req(), ctx())
    const body = await res.json() as { inviter: unknown }
    expect(body.inviter).toBeNull()
    expect(mockGetUsersByIds).not.toHaveBeenCalled()
  })

  it("previews up to 5 member avatars (id + avatar only, no names) with image-or-initial fallback", async () => {
    mockListMembers.mockResolvedValue([
      { userId: "a", userName: "Ann", userImage: "user-avatar/a" },
      { userId: "b", userName: "Bob", userImage: null },
      { userId: "c", userName: "Cy", userImage: null },
      { userId: "d", userName: "Di", userImage: null },
      { userId: "e", userName: "Ed", userImage: null },
      { userId: "f", userName: "Fi", userImage: null },
    ])
    const res = await GET(req(), ctx())
    const body = await res.json() as { memberPreview: { id: string; avatar: string }[] }
    expect(body.memberPreview).toHaveLength(5)
    // Names are intentionally NOT exposed — only id + avatar.
    expect(body.memberPreview[0]).toEqual({ id: "a", avatar: "user-avatar/a" })
    // no image → single-letter initial fallback
    expect(body.memberPreview[1]).toEqual({ id: "b", avatar: "B" })
    expect(body.memberPreview[0]).not.toHaveProperty("name")
  })

  it("maps server.icon (R2 key) through serverIconUrl into a routable URL", async () => {
    mockGetServer.mockResolvedValue({
      id: "s1",
      name: "Server One",
      icon: "server-icon/s1/abc",
      description: "",
    })

    const res = await GET(req(), ctx())
    const body = await res.json() as { serverIcon: string | null }
    expect(body.serverIcon).toBe("/api/community/servers/s1/icon")
  })
})
