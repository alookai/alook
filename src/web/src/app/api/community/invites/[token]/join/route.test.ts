import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockUseInvite = vi.fn()
const mockFanOut = vi.fn().mockResolvedValue(undefined)
const mockLogAudit = vi.fn()

vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/community/fanout", () => ({
  fanOutToServerMembers: (...a: unknown[]) => mockFanOut(...a),
}))
vi.mock("@/lib/community/audit", () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}))

vi.mock("@/lib/middleware/auth", async () => {
  return {
    withAuth: (
      handler: (req: NextRequest, ctx: {
        userId: string
        email: string
        env: { DB: unknown }
        params: Record<string, string>
      }) => Promise<Response>,
    ) => {
      return async (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => {
        const params = (await ctx.params) ?? {}
        return handler(req, {
          userId: "u_caller",
          email: "caller@example.com",
          env: { DB: {} },
          params,
        })
      }
    },
  }
})

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      communityInvite: {
        useInvite: (...a: unknown[]) => mockUseInvite(...a),
      },
    },
  }
})

async function callPOST(token: string) {
  const { POST } = await import("./route")
  const req = new NextRequest(`http://x/api/community/invites/${token}/join`, { method: "POST" })
  return POST(req, { params: Promise.resolve({ token }) })
}

beforeEach(() => {
  mockUseInvite.mockReset()
  mockFanOut.mockReset()
  mockLogAudit.mockReset()
  mockFanOut.mockResolvedValue(undefined)
})

describe("POST /api/community/invites/[token]/join", () => {
  it("broadcasts MEMBER_JOIN with the real user.name (not userId) and avatar", async () => {
    mockUseInvite.mockResolvedValue({
      invite: { id: "inv_1", serverId: "srv_1" },
      member: {
        id: "mem_1",
        userId: "u_caller",
        role: "member",
        nickname: null,
        joinedAt: "2026-07-03T00:00:00.000Z",
        userName: "Alice",
        userImage: "https://avatars/alice.png",
      },
    })

    const res = await callPOST("tok_abc")
    expect(res.status).toBe(200)

    expect(mockFanOut).toHaveBeenCalledTimes(1)
    const [serverId, event, opts] = mockFanOut.mock.calls[0]!
    expect(serverId).toBe("srv_1")
    expect(opts).toEqual({ excludeUserId: "u_caller" })
    expect(event.type).toBe("community:member.join")
    // The regression: name must be the joined user.name, NOT userId or nickname-fallback.
    expect(event.member.name).toBe("Alice")
    expect(event.member.avatar).toBe("https://avatars/alice.png")
    // Other fields carry through.
    expect(event.member.id).toBe("mem_1")
    expect(event.member.userId).toBe("u_caller")
    expect(event.member.role).toBe("member")
    expect(event.member.joinedAt).toBe("2026-07-03T00:00:00.000Z")
  })

  it("prefers nickname over userName when set", async () => {
    mockUseInvite.mockResolvedValue({
      invite: { id: "inv_1", serverId: "srv_1" },
      member: {
        id: "mem_1",
        userId: "u_caller",
        role: "member",
        nickname: "Ali",
        joinedAt: "2026-07-03T00:00:00.000Z",
        userName: "Alice",
        userImage: null,
      },
    })

    await callPOST("tok_abc")
    const [, event] = mockFanOut.mock.calls[0]!
    expect(event.member.name).toBe("Ali")
    expect(event.member.avatar).toBeUndefined()
  })

  it("returns 400 for expired/invalid invite (useInvite → null)", async () => {
    mockUseInvite.mockResolvedValue(null)
    const res = await callPOST("tok_bad")
    expect(res.status).toBe(400)
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("returns 400 on unique-constraint (already a member)", async () => {
    mockUseInvite.mockRejectedValue(new Error("UNIQUE constraint failed"))
    const res = await callPOST("tok_abc")
    expect(res.status).toBe(400)
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("returns 400 when the UNIQUE error is wrapped as .cause (DrizzleQueryError)", async () => {
    // The previous substring hack matched "UNIQUE"/"unique" on the outer
    // message only. isUniqueConstraintError walks the cause chain; this
    // regression test guards that behaviour.
    const wrapped = new Error("failed query: insert into community_member")
    ;(wrapped as { cause?: unknown }).cause = new Error(
      "UNIQUE constraint failed: community_member.user_id",
    )
    mockUseInvite.mockRejectedValue(wrapped)
    const res = await callPOST("tok_abc")
    expect(res.status).toBe(400)
    expect(mockFanOut).not.toHaveBeenCalled()
  })

  it("returns 400 when the driver reports SQLITE_CONSTRAINT_UNIQUE via .code", async () => {
    // Only reachable via the helper — the old substring hack would rethrow.
    const codeErr = new Error("constraint violation")
    ;(codeErr as { code?: string }).code = "SQLITE_CONSTRAINT_UNIQUE"
    mockUseInvite.mockRejectedValue(codeErr)
    const res = await callPOST("tok_abc")
    expect(res.status).toBe(400)
    expect(mockFanOut).not.toHaveBeenCalled()
  })
})
