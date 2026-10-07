import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  getMachineToken: vi.fn(),
  updateMachineToken: vi.fn(),
  resolveBotActor: vi.fn(),
}))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: { DB: {} } })),
}))
vi.mock("@/lib/db", () => ({ getDb: vi.fn(() => ({})) }))
vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(() => ({ api: { getSession: mocks.getSession, signOut: mocks.signOut } })),
}))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return {
    ...actual,
    queries: {
      ...actual.queries,
      machineToken: {
        ...actual.queries.machineToken,
        getMachineTokenByToken: mocks.getMachineToken,
        updateMachineTokenLastUsed: mocks.updateMachineToken,
      },
    },
  }
})
vi.mock("./community-agent-runner-auth", () => ({ resolveBotActor: mocks.resolveBotActor }))

import { withAuth, type AuthenticatedHandler } from "./auth"
import { withCommunityActor, type CommunityActorHandler } from "./community-actor"
import { withPrivateMediaCache } from "./private-media-cache"

const IMMUTABLE = "private, max-age=31536000, immutable"
const request = (headers: Record<string, string> = {}) =>
  new NextRequest("https://example.com/api/media/fixed?v=1", { headers })
const session = (id = "A", fields: Record<string, unknown> = {}) => ({
  headers: new Headers({ "Set-Cookie": "better-auth.session_data=fixture-refresh; Path=/; HttpOnly" }),
  response: { user: { id, email: `${id}@example.com`, ...fields } },
})
const media = (status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 304 ? null : "fixed media", {
    status,
    headers: { "Cache-Control": IMMUTABLE, ETag: '"media-v1"', ...headers },
  })

beforeEach(() => {
  vi.resetAllMocks()
  mocks.getSession.mockResolvedValue(session())
  mocks.getMachineToken.mockResolvedValue({ id: "mt1", userId: "A", userEmail: "a@example.com", workspaceId: "ws1" })
  mocks.resolveBotActor.mockResolvedValue({
    kind: "bot",
    actor: { botUserId: "bot1", ownerUserId: "owner1", machineId: "machine1", isActive: true },
  })
})

describe("selected private media response policy", () => {
  it.each([200, 206, 304])("preserves status %s, streaming body, validators and existing framework Vary", async (status) => {
    const original = media(status, {
      Vary: "Accept-Encoding, cOoKiE, RSC, Next-Router-State-Tree, Authorization",
      ...(status === 206 ? { "Content-Range": "bytes 0-10/100", "Accept-Ranges": "bytes" } : {}),
    })
    const result = await withPrivateMediaCache(async () => original)(request())
    expect(result.status).toBe(status)
    expect(result.body).toBe(original.body)
    expect(original.bodyUsed).toBe(false)
    expect(result.headers.get("Cache-Control")).toBe(IMMUTABLE)
    expect(result.headers.get("ETag")).toBe('"media-v1"')
    expect(result.headers.get("Vary")).toBe("Accept-Encoding, RSC, Next-Router-State-Tree, Authorization")
    if (status === 206) expect(result.headers.get("Content-Range")).toBe("bytes 0-10/100")
  })

  it.each(["*", "Accept-Encoding, *", "Cookie, *"])("preserves wildcard Vary %s", async (vary) => {
    const original = media(200, { Vary: vary })
    expect(await withPrivateMediaCache(async () => original)(request())).toBe(original)
  })

  it("preserves an explicit no-store success policy", async () => {
    const original = media(200, { "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" })
    expect(await withPrivateMediaCache(async () => original)(request())).toBe(original)
  })

  it.each([307, 400, 401, 403, 404, 416, 500, 502, 503, 504])("prohibits storage of returned status %s without altering its body or cookies", async (status) => {
    const original = new NextResponse("failure", {
      status,
      headers: { "Cache-Control": "private, max-age=60", Location: "/new-version", Vary: "Accept-Encoding" },
    })
    original.headers.append("Set-Cookie", "fixture1=clear; Path=/")
    original.headers.append("Set-Cookie", "fixture2=clear; Path=/")
    const result = await withPrivateMediaCache(async () => original)(request())
    expect(result.status).toBe(status)
    expect(result.body).toBe(original.body)
    expect(result.headers.get("Cache-Control")).toBe("private, no-store")
    expect(result.headers.get("Location")).toBe("/new-version")
    expect(result.headers.getSetCookie()).toEqual(original.headers.getSetCookie())
    expect(await result.text()).toBe("failure")
  })

  it("returns a non-storable generic 500 for an unhandled storage failure", async () => {
    const result = await withPrivateMediaCache(async () => { throw new Error("storage detail") })(request())
    expect(result.status).toBe(500)
    expect(result.headers.get("Cache-Control")).toBe("private, no-store")
    expect(await result.json()).toEqual({ error: "internal error" })
  })
})

describe("real authentication wrappers inside media policy", () => {
  it.each([200, 304])("keeps fixed media status %s independent of GA, session refresh and authenticated viewer cookies", async (status) => {
    const handler = vi.fn<AuthenticatedHandler>(async () => media(status, { Vary: "Accept-Encoding" }))
    const route = withPrivateMediaCache(withAuth(handler))
    const params = { params: Promise.resolve({ id: "fixed" }) }
    for (const [viewer, ga, sessionData] of [["A", "first", "old"], ["A", "second", "renewed"], ["B", "third", "other"]]) {
      mocks.getSession.mockResolvedValueOnce(session(viewer))
      const result = await route(request({ Cookie: `viewer=${viewer}; _ga=${ga}; better-auth.session_data=${sessionData}` }), params)
      expect(result.status).toBe(status)
      expect(result.headers.get("Vary")).toBe("Accept-Encoding, Authorization")
      expect(result.headers.get("Cache-Control")).toBe(IMMUTABLE)
      expect(result.headers.get("Set-Cookie")).toContain("better-auth.session_data=fixture-refresh")
      expect(handler.mock.lastCall?.[1]).toMatchObject({ userId: viewer, params: { id: "fixed" } })
    }
    expect(mocks.getSession).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenCalledTimes(3)
  })

  it.each(["none", "error", "bot", "deleted"])("makes an early %s session rejection non-storable and never invokes media", async (kind) => {
    if (kind === "none") mocks.getSession.mockResolvedValue({ headers: new Headers(), response: null })
    if (kind === "error") mocks.getSession.mockRejectedValue(new Error("session infrastructure"))
    if (kind === "bot") mocks.getSession.mockResolvedValue(session("bot1", { isBot: true }))
    if (kind === "deleted") mocks.getSession.mockResolvedValue(session("A", { deletedAt: "2026-10-01" }))
    const handler = vi.fn<AuthenticatedHandler>(async () => media())
    const result = await withPrivateMediaCache(withAuth(handler))(request())
    expect(result.status).toBe(kind === "error" ? 503 : 401)
    expect(result.headers.get("Cache-Control")).toBe("private, no-store")
    expect(handler).not.toHaveBeenCalled()
    if (kind === "bot" || kind === "deleted") {
      expect(mocks.signOut).toHaveBeenCalledOnce()
      expect(result.headers.get("Set-Cookie")).toContain("Max-Age=0")
    }
  })

  it.each([200, 304])("retains Authorization on machine-authenticated media status %s", async (status) => {
    const handler = vi.fn<AuthenticatedHandler>(async () => media(status))
    const result = await withPrivateMediaCache(withAuth(handler))(request({ Authorization: "Bearer al_fixture" }))
    expect(result.status).toBe(status)
    expect(result.headers.get("Vary")).toBe("Authorization")
    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(handler.mock.lastCall?.[1]).toMatchObject({ userId: "A", workspaceId: "ws1" })
  })

  it.each(["invalid", "unavailable"])("makes early %s machine auth non-storable", async (kind) => {
    if (kind === "invalid") mocks.getMachineToken.mockResolvedValue(null)
    else mocks.getMachineToken.mockRejectedValue(new Error("database unavailable"))
    const handler = vi.fn<AuthenticatedHandler>(async () => media())
    const result = await withPrivateMediaCache(withAuth(handler))(request({ Authorization: "Bearer al_fixture" }))
    expect(result.status).toBe(kind === "invalid" ? 401 : 503)
    expect(result.headers.get("Cache-Control")).toBe("private, no-store")
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(["human", "bot"])("preserves %s actor resolution on fixed attachment thumbnails", async (kind) => {
    const handler = vi.fn<CommunityActorHandler>(async () => media())
    const headers: Record<string, string> = kind === "bot" ? { Authorization: "Bearer crk_fixture" } : { Cookie: "viewer=A; _ga=changed" }
    const result = await withPrivateMediaCache(withCommunityActor(handler))(request(headers))
    expect(result.headers.get("Vary")).toBe("Authorization")
    expect(handler.mock.lastCall?.[1].actor.kind).toBe(kind)
    expect(mocks.getSession).toHaveBeenCalledTimes(kind === "human" ? 1 : 0)
  })

  it("adds no cache TTL to bot downloads and separates them by Authorization", async () => {
    const result = await withPrivateMediaCache(withCommunityActor(async () => new Response("bot bytes", {
      headers: { "X-Alook-Filename": "file.bin", "Content-Length": "9" },
    })))(request({ Authorization: "Bearer crk_fixture" }))
    expect(result.headers.get("Cache-Control")).toBeNull()
    expect(result.headers.get("Vary")).toBe("Authorization")
    expect(result.headers.get("X-Alook-Filename")).toBe("file.bin")
    expect(await result.text()).toBe("bot bytes")
  })

  it.each([401, 503])("makes bot auth status %s non-storable without falling through to the human session", async (status) => {
    mocks.resolveBotActor.mockResolvedValue({ kind: "error", response: NextResponse.json({ error: "runner auth" }, { status }) })
    const handler = vi.fn<CommunityActorHandler>(async () => media())
    const result = await withPrivateMediaCache(withCommunityActor(handler))(request({ Authorization: "Bearer crk_fixture" }))
    expect(result.status).toBe(status)
    expect(result.headers.get("Cache-Control")).toBe("private, no-store")
    expect(handler).not.toHaveBeenCalled()
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it("keeps default private account responses credential-specific outside the selected media wrapper", async () => {
    const result = await withAuth(async () => media())(request())
    expect(result.headers.get("Vary")).toBe("Cookie, Authorization")
  })
})
