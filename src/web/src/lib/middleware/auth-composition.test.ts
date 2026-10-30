import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_BOT_ACTOR_HEADER, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { createAuth } from "./auth-policy"
import { withAuth, withCookieHumanAuth, withOptionalAuth } from "./auth"
import { communityActorPolicy, rejectBot, withCommunityActor } from "./community-actor"
import { withCommunityDaemonAuth } from "./community-daemon-auth"
import { withCommunityPairingToken } from "./community-pairing-token"
import * as responses from "./response-cache"

vi.mock("./response-cache", async original => {
  const actual = await original<typeof import("./response-cache")>()
  return { ...actual, protectCommunityJsonResponse: vi.fn(actual.protectCommunityJsonResponse) }
})

const m = vi.hoisted(() => ({
  session: vi.fn(), signOut: vi.fn(), user: vi.fn(), runner: vi.fn(), binding: vi.fn(), owned: vi.fn(), machine: vi.fn(),
  env: { DB: {}, CACHE_KV: {} }, execution: { waitUntil: vi.fn() },
}))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(async () => ({ env: m.env, ctx: m.execution })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})), getPrimaryDb: vi.fn(() => ({})) }))
vi.mock("@/lib/cache", () => ({ bindCacheKV: vi.fn() }))
vi.mock("@/lib/auth", () => ({ getAuth: () => ({ api: { getSession: m.session, signOut: m.signOut } }) }))
vi.mock("@alook/shared", async original => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, withD1Retry: async (fn: () => Promise<unknown>) => fn(), queries: {
    ...actual.queries,
    user: { ...actual.queries.user, getUserInternal: m.user },
    communityMachine: { ...actual.queries.communityMachine, findActiveAgentRunnerKeyByBearer: m.runner, findActiveCredentialByBearer: m.machine },
    communityBot: { ...actual.queries.communityBot, getBotBinding: m.binding, getBotOwnedBy: m.owned },
  } }
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  m.session.mockImplementation(async () => ({ headers: new Headers({ "Set-Cookie": "better-auth.session_data=fresh; HttpOnly" }), response: { user: { id: "owner", email: "owner@example.test" } } }))
  m.user.mockImplementation(async (_db, id) => ({ id, email: "owner@example.test", isBot: id === "bot", deletedAt: null }))
  m.runner.mockResolvedValue({ userId: "owner", machineId: "machine", agentId: "bot" })
  m.binding.mockResolvedValue({ machineId: "machine", isActive: true })
  m.owned.mockResolvedValue({ id: "bot", machineId: "machine", isActive: true })
  m.machine.mockResolvedValue({ userId: "owner", machineId: "machine", credentialId: "credential" })
})

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://alook.test/api/community/operation", {
    method: "POST", body: '{"value":1}',
    headers: { Origin: "https://alook.test", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION), ...headers },
  })
}

const cases = [
  { name: "human", wrap: withAuth, headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "human actor", wrap: withCommunityActor, headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "delegated bot", wrap: withCommunityActor, headers: { [COMMUNITY_BOT_ACTOR_HEADER]: "bot" }, calls: [1, 0, 0, 0, 1, 0], protected: 1 },
  { name: "runner", wrap: withCommunityActor, headers: { Authorization: "Bearer crk_test" }, calls: [0, 1, 1, 1, 0, 0], protected: 1 },
  { name: "sensitive human", wrap: withCookieHumanAuth, headers: {}, calls: [1, 1, 0, 0, 0, 0], protected: 1 },
  { name: "optional human", wrap: withOptionalAuth, headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "machine", wrap: withCommunityDaemonAuth, headers: { Authorization: "Bearer cmk_test" }, calls: [0, 0, 0, 0, 0, 1], protected: 0 },
  { name: "pairing", wrap: withCommunityPairingToken, headers: { Authorization: "Bearer cmt_test" }, calls: [0, 0, 0, 0, 0, 0], protected: 0 },
]

describe("composed credential execution", () => {
  it.each(cases)("$name resolves once and leaves the body for business code", async ({ wrap, headers, calls, protected: protections }) => {
    const protect = vi.mocked(responses.protectCommunityJsonResponse)
    const handler = vi.fn(async (req: NextRequest, ctx: { params?: Record<string, string> }) => {
      expect(req.bodyUsed).toBe(false)
      expect(ctx.params).toEqual({ id: "resource" })
      return NextResponse.json(await req.json())
    })
    const response = await wrap(handler)(request(headers), { params: Promise.resolve({ id: "resource" }) })
    expect(await response.json()).toEqual({ value: 1 })
    expect(handler).toHaveBeenCalledOnce()
    expect([m.session, m.user, m.runner, m.binding, m.owned, m.machine].map(fn => fn.mock.calls.length)).toEqual(calls)
    expect(protect).toHaveBeenCalledTimes(protections)
  })

  it("composes a resource gate after credentials and before any business read", async () => {
    const handler = vi.fn(async () => NextResponse.json({ private: true }))
    const authorize = vi.fn((_req, ctx) => rejectBot(ctx.actor))
    const wrap = createAuth({ ...communityActorPolicy(), authorize })
    const response = await wrap(handler)(request({ [COMMUNITY_BOT_ACTOR_HEADER]: "bot" }))
    expect(response.status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect(authorize).toHaveBeenCalledOnce()
    expect(m.session).toHaveBeenCalledOnce()
    expect(m.owned).toHaveBeenCalledWith({}, "bot", "owner")
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
    expect(await response.json()).toMatchObject({ error: { code: "not_allowed", message: "forbidden: not available to bots" } })
  })

  it("keeps session refresh on delegation failure without authenticating twice", async () => {
    m.owned.mockResolvedValue(null)
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await withCommunityActor(handler)(request({ [COMMUNITY_BOT_ACTOR_HEADER]: "foreign" }))
    expect(response.status).toBe(404)
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
    expect(m.session).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  })

  it("never tries a cookie after a rejected recognized runner", async () => {
    m.runner.mockResolvedValue(null)
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await withCommunityActor(handler)(request({ Authorization: "Bearer crk_revoked", Cookie: "better-auth.session_token=live" }))
    expect(response.status).toBe(401)
    expect(m.session).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("forwards a business cookie in preference to the session refresh", async () => {
    const response = await withCommunityActor(async () => new Response("done", { headers: { "Set-Cookie": "better-auth.session_data=business; HttpOnly" } }))(request())
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=business; HttpOnly"])
  })
})
