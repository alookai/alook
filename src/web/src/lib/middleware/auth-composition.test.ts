import { SESSION_ACCOUNT_HEADER, SESSION_ACCOUNT_MISMATCH_HEADER } from "@/lib/session-account"
import { withAuth } from "./auth-policy"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_BOT_ACTOR_HEADER, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { humanAuthPolicy, cookieHumanAuthPolicy, optionalAuthPolicy } from "./auth"
import { communityActorPolicy, rejectBot } from "./community-actor"
import { machineAuthPolicy } from "./community-daemon-auth"
import { pairingTokenPolicy } from "./community-pairing-token"
import * as responses from "./response-cache"
import { automationManagementPolicy } from "../automation"

vi.mock("./response-cache", async original => {
  const actual = await original<typeof import("./response-cache")>()
  return { ...actual, protectCommunityJsonResponse: vi.fn(actual.protectCommunityJsonResponse) }
})

const m = vi.hoisted(() => ({
  settings: vi.fn(), session: vi.fn(), signOut: vi.fn(), user: vi.fn(), runner: vi.fn(), binding: vi.fn(), owned: vi.fn(), machine: vi.fn(),
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
    communityNotificationSetting: { ...actual.queries.communityNotificationSetting, getSettings: m.settings },
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
  { name: "human", policy: humanAuthPolicy, headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "human actor", policy: communityActorPolicy(), headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "delegated bot", policy: communityActorPolicy(), headers: { [COMMUNITY_BOT_ACTOR_HEADER]: "bot" }, calls: [1, 0, 0, 0, 1, 0], protected: 1 },
  { name: "runner", policy: communityActorPolicy(), headers: { Authorization: "Bearer crk_test" }, calls: [0, 1, 1, 1, 0, 0], protected: 1 },
  { name: "sensitive human", policy: cookieHumanAuthPolicy, headers: {}, calls: [1, 1, 0, 0, 0, 0], protected: 1 },
  { name: "optional human", policy: optionalAuthPolicy, headers: {}, calls: [1, 0, 0, 0, 0, 0], protected: 1 },
  { name: "machine", policy: machineAuthPolicy, headers: { Authorization: "Bearer cmk_test" }, calls: [0, 0, 0, 0, 0, 1], protected: 0 },
  { name: "pairing", policy: pairingTokenPolicy, headers: { Authorization: "Bearer cmt_test" }, calls: [0, 0, 0, 0, 0, 0], protected: 0 },
]

describe("composed credential execution", () => {
  it.each(cases)("$name resolves once and leaves the body for business code", async ({ policy, headers, calls, protected: protections }) => {
    const protect = vi.mocked(responses.protectCommunityJsonResponse)
    const handler = vi.fn(async (req: NextRequest, ctx: { params?: Record<string, string> }) => {
      expect(req.bodyUsed).toBe(false)
      expect(ctx.params).toEqual({ id: "resource" })
      return NextResponse.json(await req.json())
    })
    const response = await withAuth(policy, handler)(request(headers), { params: Promise.resolve({ id: "resource" }) })
    expect(await response.json()).toEqual({ value: 1 })
    expect(handler).toHaveBeenCalledOnce()
    expect([m.session, m.user, m.runner, m.binding, m.owned, m.machine].map(fn => fn.mock.calls.length)).toEqual(calls)
    expect(protect).toHaveBeenCalledTimes(protections)
  })

  it("composes a resource gate after credentials and before any business read", async () => {
    const handler = vi.fn(async () => NextResponse.json({ private: true }))
    const authorize = vi.fn((_req, ctx) => rejectBot(ctx.actor))
    const response = await withAuth({ ...communityActorPolicy(), authorize }, handler)(request({ [COMMUNITY_BOT_ACTOR_HEADER]: "bot" }))
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
    const response = await withAuth(communityActorPolicy(), handler)(request({ [COMMUNITY_BOT_ACTOR_HEADER]: "foreign" }))
    expect(response.status).toBe(404)
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
    expect(m.session).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  })

  it("never tries a cookie after a rejected recognized runner", async () => {
    m.runner.mockResolvedValue(null)
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await withAuth(communityActorPolicy(), handler)(request({ Authorization: "Bearer crk_revoked", Cookie: "better-auth.session_token=live" }))
    expect(response.status).toBe(401)
    expect(m.session).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("forwards a business cookie in preference to the session refresh", async () => {
    const response = await withAuth(communityActorPolicy(), async () => new Response("done", { headers: { "Set-Cookie": "better-auth.session_data=business; HttpOnly" } }))(request())
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=business; HttpOnly"])
  })
})

describe("automation management composed with human auth", () => {
  it.each(["", "Bearer aac_test", "Bearer crk_test", "Bearer cmk_test", "Basic unknown"])("rejects %j before session, bot selection and protocol checks", async authorization => {
    const handler = vi.fn(async () => Response.json({ ok: true }))
    const req = request({ Authorization: authorization, Cookie: "present", [COMMUNITY_BOT_ACTOR_HEADER]: "bot", [COMMUNITY_CONTRACT_HEADER]: "invalid" })
    const response = await withAuth(automationManagementPolicy, handler)(req)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Sign in to manage access codes" })
    expect(response.headers.get("Cache-Control")).toBeNull()
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBeNull()
    expect(m.session).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(responses.protectCommunityJsonResponse).not.toHaveBeenCalled()
  })

  it("shares human resolution once and retains Cookie refresh, params and response protection", async () => {
    const handler = vi.fn(async (_req, ctx) => Response.json({ owner: ctx.userId, params: ctx.params }))
    const response = await withAuth(automationManagementPolicy, handler)(request(), { params: Promise.resolve({ codeId: "own-code" }) })
    expect(await response.json()).toEqual({ owner: "owner", params: { codeId: "own-code" } })
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
    expect(m.session).toHaveBeenCalledOnce()
    expect(responses.protectCommunityJsonResponse).toHaveBeenCalledOnce()
  })
})

describe("cookie session account constraint", () => {
  const policies = cases.filter(({ name }) => ["human", "human actor", "delegated bot", "sensitive human", "optional human"].includes(name))
  for (const { name, policy, headers } of policies) {
    describe(name, () => {
      it.each(["stale", "owner", undefined])("validates expected account %s before business code and preserves renewal", async expected => {
        const handler = vi.fn(async () => NextResponse.json({ ok: true }))
        const response = await withAuth(policy, handler)(request({ ...headers, ...(expected === undefined ? {} : { [SESSION_ACCOUNT_HEADER]: expected }) }))
        expect(m.session).toHaveBeenCalledOnce()
        expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
        if (expected === "stale") {
          expect(response.status).toBe(409)
          expect(response.headers.get(SESSION_ACCOUNT_MISMATCH_HEADER)).toBe("1")
          expect(handler).not.toHaveBeenCalled()
          expect(m.user).not.toHaveBeenCalled()
          expect(m.owned).not.toHaveBeenCalled()
          expect(await response.text()).not.toContain("owner")
        } else {
          expect(response.status).toBe(200)
          expect(handler).toHaveBeenCalledOnce()
        }
      })
    })
  }

  it.each([humanAuthPolicy, communityActorPolicy(), optionalAuthPolicy])("rejects stale GET reads through the shared resolver", async policy => {
    const handler = vi.fn(async () => NextResponse.json({ settings: "private" }))
    const response = await withAuth(policy, handler)(new NextRequest("https://alook.test/api/community/users/me/notifications", {
      headers: { [SESSION_ACCOUNT_HEADER]: "stale", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
    }))
    expect(response.status).toBe(409)
    expect(handler).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
  })
})

it("rejects the actual notification route before it reads a different session's settings", async () => {
  const { GET } = await import("@/app/api/community/users/me/notifications/route")
  const response = await GET(new NextRequest("https://alook.test/api/community/users/me/notifications", {
    headers: { [SESSION_ACCOUNT_HEADER]: "stale", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) },
  }))
  expect(response.status).toBe(409)
  expect(m.settings).not.toHaveBeenCalled()
  expect(m.session).toHaveBeenCalledOnce()
  expect(response.headers.getSetCookie()).toEqual(["better-auth.session_data=fresh; HttpOnly"])
})
