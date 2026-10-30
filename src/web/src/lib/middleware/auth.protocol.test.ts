import { withAuth } from "./auth-policy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { communityActorPolicy } from "./community-actor"
import { apiFetch } from "@/lib/api/client"
import { humanAuthPolicy, cookieHumanAuthPolicy, optionalAuthPolicy, type OptionalAuthHandler } from "./auth"

const mocks = vi.hoisted(() => ({ session: vi.fn(), signOut: vi.fn(), user: vi.fn(), machine: vi.fn(), bump: vi.fn(), bot: vi.fn() }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: vi.fn(async () => ({ env: { DB: {} }, ctx: { waitUntil: vi.fn() } })) }))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})), getPrimaryDb: vi.fn(() => ({})) }))
vi.mock("./community-agent-runner-auth", () => ({ resolveBotActor: mocks.bot }))
vi.mock("@/lib/auth", () => ({ getAuth: vi.fn(() => ({ api: { getSession: mocks.session, signOut: mocks.signOut } })) }))
vi.mock("@alook/shared", async original => {
  const actual = await original<typeof import("@alook/shared")>()
  return { ...actual, createDb: vi.fn(() => ({})), queries: { ...actual.queries, user: { ...actual.queries.user, getUserInternal: mocks.user } } }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.mockResolvedValue({ headers: new Headers({ "Set-Cookie": "better-auth.session_data=refreshed; HttpOnly" }), response: { user: { id: "viewer", email: "cached@example.test" } } })
  mocks.user.mockResolvedValue({ id: "viewer", email: "current@example.test", isBot: false, deletedAt: null })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function connect(handler: ReturnType<typeof withAuth>) {
  let received: NextRequest | undefined, produced: Response | undefined
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    received = new NextRequest(new URL(path, "https://alook.test"), options)
    produced = await handler(received)
    return produced
  }))
  return { get request() { return received! }, get response() { return produced! } }
}
const sameOrigin = { Origin: "https://alook.test" }

describe("current auth wrapper producer to API consumer", () => {
  it("admits anonymous current invite info through optional auth", async () => {
    mocks.session.mockResolvedValue({ headers: new Headers(), response: null })
    const handler = vi.fn(async (_req: NextRequest, ctx: Parameters<OptionalAuthHandler>[1]) => NextResponse.json({ serverId: "server", anonymous: ctx.userId === undefined }))
    const transport = connect(withAuth(optionalAuthPolicy, handler))
    expect(await apiFetch("/api/community/invites/token/info")).toEqual({ serverId: "server", anonymous: true })
    expect(transport.request.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(transport.response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(transport.response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0")
  })
  it("preserves optional-auth failure status and current readable error", async () => {
    connect(withAuth(optionalAuthPolicy, async () => NextResponse.json({ error: "invite expired" }, { status: 410 })))
    await expect(apiFetch("/api/community/invites/token/info")).rejects.toMatchObject({ name: "ApiError", status: 410, message: "invite expired" })
  })
  it("confirms a live Cookie human result and forwards refreshed cookies", async () => {
    const transport = connect(withAuth(cookieHumanAuthPolicy, async (_req, ctx) => NextResponse.json({ userId: ctx.userId, email: ctx.email })))
    expect(await apiFetch("/api/community/billing/portal", { method: "POST", headers: sameOrigin })).toEqual({ userId: "viewer", email: "current@example.test" })
    expect(transport.response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(transport.response.headers.get("Set-Cookie")).toContain("session_data=refreshed")
  })
  it("preserves current operation error messages through Cookie auth and apiFetch", async () => {
    connect(withAuth(cookieHumanAuthPolicy, async () => NextResponse.json({ error: "INVALID_OTP" }, { status: 400 })))
    await expect(apiFetch("/api/community/users/me/account-deletion", { method: "POST", headers: sameOrigin })).rejects.toMatchObject({ name: "ApiError", status: 400, message: "INVALID_OTP" })
  })
  it("keeps Origin rejection before session lookup", async () => {
    connect(withAuth(cookieHumanAuthPolicy, async () => NextResponse.json({ ok: true })))
    await expect(apiFetch("/api/community/billing/portal", { method: "POST", headers: { Origin: "https://other.test" } })).rejects.toMatchObject({ name: "ApiError", status: 403, message: "FORBIDDEN" })
    expect(mocks.session).not.toHaveBeenCalled()
  })
  it("keeps a qualified401 transition and current protected response", async () => {
    mocks.session.mockResolvedValue({ headers: new Headers(), response: null })
    const transport = connect(withAuth(cookieHumanAuthPolicy, async () => NextResponse.json({ ok: true })))
    const onUnauthorized = vi.fn(async () => false)
    await expect(apiFetch("/api/community/billing/portal", { method: "POST", headers: sameOrigin, onUnauthorized })).rejects.toMatchObject({ name: "AbortError" })
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(transport.response.status).toBe(401)
    expect(transport.response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
  })
  it("keeps outside-community privacy Cookie operations independent", async () => {
    const transport = connect(withAuth(cookieHumanAuthPolicy, async () => NextResponse.json({ consent: false })))
    expect(await apiFetch("/api/privacy/analytics-consent", { method: "POST", headers: sameOrigin })).toEqual({ consent: false })
    expect(transport.request.headers.get(COMMUNITY_CONTRACT_HEADER)).toBeNull()
    expect(transport.response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBeNull()
  })
  it.each(["optional", "cookie"])("rejects an old request before the %s handler/session", async kind => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const wrapped = kind === "cookie" ? withAuth(cookieHumanAuthPolicy, handler) : withAuth(optionalAuthPolicy, handler)
    const response = await wrapped(new NextRequest("https://alook.test/api/community/operation", { method: "POST", headers: { ...sameOrigin, [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION - 1) } }))
    expect(response.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
    expect(mocks.session).not.toHaveBeenCalled()
  })
})

describe("independent actor qualification", () => {
  function wrap(kind: string, handler: () => Promise<Response>) {
    return kind === "optional" ? withAuth(optionalAuthPolicy, handler) : kind === "actor" ? withAuth(communityActorPolicy(), handler) : withAuth(humanAuthPolicy, handler)
  }
  it.each(["auth", "optional", "actor"].flatMap(kind => [null, BUSINESS_SCHEMA_VERSION - 1].map(version => ({ kind, version }))))("rejects an unqualified Bearer with live Cookie ($kind/$version)", async ({ kind, version }) => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await wrap(kind, handler)(new NextRequest("https://alook.test/api/community/operation", { headers: { Cookie: "better-auth.session_token=live", Authorization: "Bearer invalid", ...(version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: String(version) }) } }))
    expect(response.status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
  })
  it.each(["auth", "optional", "actor"])("preserves current-header Cookie fallback (%s)", async kind => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await wrap(kind, handler)(new NextRequest("https://alook.test/api/community/operation", { headers: { Cookie: "better-auth.session_token=live", Authorization: "Bearer invalid", [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION) } }))
    expect(response.status).toBe(200); expect(handler).toHaveBeenCalledOnce()
    expect(mocks.session).toHaveBeenCalledOnce()
  })
  it.each(["cookie", "runner"])("preserves asynchronous handler error identity (%s)", async kind => {
    const failure = new Error("route failed")
    const handler = vi.fn(async () => { throw failure })
    mocks.bot.mockResolvedValue({ kind: "ok", actor: { botUserId: "bot", ownerUserId: "viewer", machineId: "machine", isActive: true } })
    const request = new NextRequest("https://alook.test/api/community/operation", {
      headers: {
        Cookie: "better-auth.session_token=live",
        [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
        ...(kind === "runner" ? { Authorization: "Bearer crk_credential" } : {}),
      },
    })
    await expect(wrap(kind === "runner" ? "actor" : "auth", handler)(request)).rejects.toBe(failure)
    expect(handler).toHaveBeenCalledOnce()
    if (kind === "runner") {
      expect(mocks.bot).toHaveBeenCalledOnce()
      expect(mocks.session).not.toHaveBeenCalled()
    } else {
      expect(mocks.session).toHaveBeenCalledOnce()
      expect(mocks.bot).not.toHaveBeenCalled()
    }
  })
  it.each([true, false])("qualifies bot credentials before an independent request (%s)", async valid => {
    mocks.bot.mockResolvedValue(valid ? { kind: "ok", actor: { botUserId: "bot", ownerUserId: "viewer", machineId: "machine", isActive: true } } : { kind: "error", response: NextResponse.json({ error: "invalid runner key" }, { status: 401 }) })
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const response = await withAuth(communityActorPolicy(), handler)(new NextRequest("https://alook.test/api/community/operation", { headers: { Cookie: "better-auth.session_token=live", Authorization: "Bearer crk_credential" } }))
    expect(response.status).toBe(valid ? 200 : 401)
    expect(handler).toHaveBeenCalledTimes(valid ? 1 : 0)
    expect(mocks.bot).toHaveBeenCalledOnce(); expect(mocks.session).not.toHaveBeenCalled()
  })
})

describe("current independent media capability", () => {
  it("admits the actual bot-avatar GET family after Cookie auth without a business header", async () => {
    const handler = vi.fn(async () => new Response("png", { headers: { "Content-Type": "image/png" } }))
    const response = await withAuth(humanAuthPolicy, handler)(new NextRequest("https://alook.test/api/community/bots/bot/avatar?v=2", { headers: { Cookie: "better-auth.session_token=live" } }))
    expect(response.status).toBe(200); expect(await response.text()).toBe("png")
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.session).toHaveBeenCalledOnce()
    expect(response.headers.get(COMMUNITY_CONTRACT_HEADER)).toBeNull()
  })
  it("keeps the same media read session-qualified", async () => {
    mocks.session.mockResolvedValue({ headers: new Headers(), response: null })
    const handler = vi.fn(async () => new Response("png"))
    const response = await withAuth(humanAuthPolicy, handler)(new NextRequest("https://alook.test/api/community/bots/bot/avatar"))
    expect(response.status).toBe(401); expect(handler).not.toHaveBeenCalled()
  })
  it("requires the current JSON contract on bot-avatar upload", async () => {
    const handler = vi.fn(async () => NextResponse.json({ url: "avatar" }))
    const response = await withAuth(humanAuthPolicy, handler)(new NextRequest("https://alook.test/api/community/bots/bot/avatar", { method: "POST", headers: { Cookie: "better-auth.session_token=live" } }))
    expect(response.status).toBe(400); expect(handler).not.toHaveBeenCalled()
  })
})
