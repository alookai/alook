import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
// Unified actor: a request with no `crk_` bearer falls through to the human
// withAuth path. Mock Better-Auth to resolve "no session" so a no-auth request
// yields the human-path 401 ("unauthorized") — the real unified-actor contract —
// instead of a 503 from unmocked session validation.
vi.mock("@/lib/auth", () => ({
  createAuth: vi.fn(() => ({
    api: { getSession: vi.fn(async () => ({ headers: new Headers(), response: null })) },
  })),
}))

const mockFindActiveAgentRunnerKeyByBearer = vi.fn()
const mockGetUserInternal = vi.fn()
const mockGetBotBinding = vi.fn()
const mockResolveServerByNameForMember = vi.fn()
const mockListMembersPaginated = vi.fn()
const mockFetchOnlineUserIds = vi.fn()

vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      communityMachine: { findActiveAgentRunnerKeyByBearer: (...a: unknown[]) => mockFindActiveAgentRunnerKeyByBearer(...a) },
      user: { getUserInternal: (...a: unknown[]) => mockGetUserInternal(...a) },
      communityBot: { getBotBinding: (...a: unknown[]) => mockGetBotBinding(...a) },
      communityServer: { resolveServerByNameForMember: (...a: unknown[]) => mockResolveServerByNameForMember(...a) },
      communityMember: { listMembersPaginated: (...a: unknown[]) => mockListMembersPaginated(...a) },
    },
  }
})

// Presence is a bulk ws-do fan-out — mock the helper so the route test stays
// unit-scoped. The set it returns drives each member's `online` boolean.
vi.mock("@/lib/community/member-presence", async () => {
  const actual = await vi.importActual<typeof import("@/lib/community/member-presence")>(
    "@/lib/community/member-presence",
  )
  return {
    ...actual,
    fetchOnlineUserIds: (...a: unknown[]) => mockFetchOnlineUserIds(...a),
  }
})

import { GET } from "./route"

// Bot arm of the dual-actor GET servers/[id]/members (folds the flat
// `listMembers` verb). The bot addresses by `?server=<ref>` (+ optional
// `limit`/`cursor`); the `[id]` path segment is the `resolve` placeholder the
// daemon sends. A no-crk_ request falls through to the human withAuth arm
// (401 here via the mocked no-session auth).
function req(
  params: { server?: string; limit?: number; cursor?: string },
  headers: Record<string, string> = {},
): NextRequest {
  const url = new URL("http://localhost/api/community/servers/resolve/members")
  if (params.server !== undefined) url.searchParams.set("server", params.server)
  if (params.limit !== undefined) url.searchParams.set("limit", String(params.limit))
  if (params.cursor !== undefined) url.searchParams.set("cursor", params.cursor)
  return new NextRequest(url, {
    method: "GET",
    headers: { ...headers },
  })
}

describe("GET /api/community/servers/[id]/members — bot arm (folds listMembers)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindActiveAgentRunnerKeyByBearer.mockResolvedValue({ userId: "owner_1", machineId: "m_1", agentId: "bot_1" })
    mockGetUserInternal.mockResolvedValue({ isBot: true, deletedAt: null })
    mockGetBotBinding.mockResolvedValue({ machineId: "m_1", runtime: "claude" })
    mockFetchOnlineUserIds.mockResolvedValue(new Set<string>())
  })

  it("401 without Authorization", async () => {
    const res = await GET(req({ server: "Design Studio#0042" }), { params: { id: "resolve" } } as any)
    expect(res.status).toBe(401)
    expect(mockResolveServerByNameForMember).not.toHaveBeenCalled()
  })

  it("404 when the server name/id doesn't resolve for this bot", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([])
    const res = await GET(req({ server: "Nope#0042" }, { Authorization: "Bearer crk_abc" }), { params: { id: "resolve" } } as any)
    expect(res.status).toBe(404)
    expect(mockListMembersPaginated).not.toHaveBeenCalled()
  })

  it("200 maps rows to {handle, role, online, status}, defaulting null role to member", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "Design Studio" }])
    mockListMembersPaginated.mockResolvedValue({
      members: [
        { id: "sm_1", userId: "u_gus", joinedAt: "2026-01-01T00:00:00Z", userName: "gustavo", discriminator: "4821", role: "owner", statusEmoji: "🍜", statusText: "lunch" },
        { id: "sm_2", userId: "u_ally", joinedAt: "2026-01-02T00:00:00Z", userName: "ally", discriminator: "0192", role: null, statusEmoji: null, statusText: null },
      ],
      hasMore: false,
      cursor: undefined,
    })
    // u_gus online, u_ally offline — proves the per-page bulk presence stamps each row.
    mockFetchOnlineUserIds.mockResolvedValue(new Set(["u_gus"]))
    const res = await GET(req({ server: "Design Studio#0042" }, { Authorization: "Bearer crk_abc" }), { params: { id: "resolve" } } as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      members: [
        { handle: "gustavo#4821", role: "owner", online: true, status: { emoji: "🍜", text: "lunch" } },
        { handle: "ally#0192", role: "member", online: false, status: { emoji: null, text: "" } },
      ],
      hasMore: false,
    })
  })

  it("threads limit + cursor and returns the next-page cursor + hasMore", async () => {
    mockResolveServerByNameForMember.mockResolvedValue([{ id: "srv_1", name: "Design Studio" }])
    mockListMembersPaginated.mockResolvedValue({
      members: [
        { id: "sm_9", userId: "u_z", joinedAt: "2026-03-01T00:00:00Z", userName: "zoe", discriminator: "0001", role: "member", statusEmoji: null, statusText: null },
      ],
      hasMore: true,
      cursor: { joinedAt: "2026-03-01T00:00:00Z", id: "sm_9" },
    })
    const res = await GET(
      req({ server: "Design Studio#0042", limit: 1, cursor: "2026-02-01T00:00:00Z|sm_5" }, { Authorization: "Bearer crk_abc" }),
      { params: { id: "resolve" } } as any,
    )
    expect(res.status).toBe(200)
    // limit passed through; cursor string parsed into {joinedAt, id}.
    expect(mockListMembersPaginated).toHaveBeenCalledWith(expect.anything(), "srv_1", {
      cursor: { joinedAt: "2026-02-01T00:00:00Z", id: "sm_5" },
      limit: 1,
    })
    // only this page's user id is presence-batched — never per-member.
    expect(mockFetchOnlineUserIds).toHaveBeenCalledWith(expect.anything(), ["u_z"], "srv_1")
    const body = await res.json()
    expect(body.hasMore).toBe(true)
    // opaque next-page cursor rebuilt as "joinedAt|id".
    expect(body.cursor).toBe("2026-03-01T00:00:00Z|sm_9")
  })
})
