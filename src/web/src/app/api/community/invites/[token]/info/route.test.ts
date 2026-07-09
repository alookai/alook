import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))

const mockGetInviteByToken = vi.fn()
const mockGetServer = vi.fn()
const mockCountMembers = vi.fn()
const mockListMembers = vi.fn()

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
    },
  }
})

// Two `withAuth` shapes are covered in tests:
//   * `authed` — the default: calls the handler as if the caller is signed in.
//   * `anonymous` — returns 401 without calling the handler.
// The mock is `let`-mutated between blocks so we can flip the behaviour per
// test.
let isAuthed = true

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: any) => async (req: any, ctx?: any) => {
    if (!isAuthed) {
      const { NextResponse } = require("next/server")
      return NextResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    const params = ctx?.params instanceof Promise ? await ctx.params : ctx?.params
    return handler(req, { env: { DB: {} }, userId: "u1", email: "u@t.com", params })
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
  })

  it("returns memberCount resolved via countMembers, never listMembers", async () => {
    mockCountMembers.mockResolvedValue(42)

    const res = await GET(req(), ctx())

    expect(res.status).toBe(200)
    const body = await res.json() as { memberCount: number }
    expect(body.memberCount).toBe(42)

    expect(mockCountMembers).toHaveBeenCalledTimes(1)
    expect(mockCountMembers).toHaveBeenCalledWith(expect.anything(), "s1")
    expect(mockListMembers).not.toHaveBeenCalled()
  })

  it("returns 401 for anonymous callers", async () => {
    isAuthed = false
    const res = await GET(req(), ctx())
    expect(res.status).toBe(401)
    expect(mockGetInviteByToken).not.toHaveBeenCalled()
  })

  it("returns 200 with no serverDescription key for authed callers", async () => {
    mockCountMembers.mockResolvedValue(3)
    const res = await GET(req(), ctx())
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).not.toHaveProperty("serverDescription")
    expect(body.serverName).toBe("Server One")
    expect(body.memberCount).toBe(3)
  })

  it("maps server.icon (R2 key) through serverIconUrl into a routable URL", async () => {
    mockGetServer.mockResolvedValue({
      id: "s1",
      name: "Server One",
      icon: "server-icon/s1/abc",
      description: "",
    })
    mockCountMembers.mockResolvedValue(1)

    const res = await GET(req(), ctx())
    const body = await res.json() as { serverIcon: string | null }
    expect(body.serverIcon).toBe("/api/community/servers/s1/icon")
  })
})
