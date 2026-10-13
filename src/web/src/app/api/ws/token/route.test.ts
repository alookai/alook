import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const mockGetSession = vi.fn()
const mockEnv = vi.hoisted(() => ({ current: {} as Record<string, unknown> }))

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(async () => ({ env: {} })),
}))

vi.mock("@/lib/auth", () => ({
  getAuth: vi.fn(() => ({
    api: { getSession: (...a: unknown[]) => mockGetSession(...a) },
  })),
}))

vi.mock("@/lib/middleware/env", () => ({
  withEnv: vi.fn((handler: any) => async (req: any, ctx?: any) => handler(req, ctx ?? { env: mockEnv.current })),
}))

import { GET } from "./route"

describe("GET /api/ws/token", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.current = {}
  })

  it("returns 401 when there is no session", async () => {
    mockGetSession.mockResolvedValue(Response.json(null))
    const res = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(res.status).toBe(401)
  })

  it("returns userId and session token for an authenticated caller", async () => {
    mockGetSession.mockResolvedValue(Response.json({
      user: { id: "u_1" },
      session: { token: "sess_tok" },
    }))
    const res = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe("u_1")
    expect(body.token).toBe("sess_tok")
  })

  it("requests the native SDK response with the original request headers", async () => {
    mockGetSession.mockResolvedValue(Response.json(null))
    const request = new NextRequest("http://localhost/api/ws/token", { headers: { Cookie: "fixture=signed" } })
    await GET(request)
    expect(mockGetSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers, asResponse: true })
  })

  it.each(["", "?refresh=0", "?refresh=true"])("keeps the ordinary cache path for %s", async (query) => {
    mockGetSession.mockResolvedValue(Response.json(null))
    const request = new NextRequest(`http://localhost/api/ws/token${query}`)
    await GET(request)
    expect(mockGetSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers, asResponse: true })
  })

  it("requests an authoritative SDK lookup only for refresh=1", async () => {
    mockGetSession.mockResolvedValue(Response.json(null))
    const request = new NextRequest("http://localhost/api/ws/token?refresh=1")
    await GET(request)
    expect(mockGetSession).toHaveBeenCalledExactlyOnceWith({ headers: request.headers, asResponse: true, query: { disableCookieCache: true } })
  })

  it.each([true, false])("forwards every refresh/chunk/deletion cookie with authenticated=%s", async (authenticated) => {
    const headers = new Headers()
    for (const value of [
      "cache.0=updated; HttpOnly; Path=/; Max-Age=300",
      "cache.1=; HttpOnly; Path=/; Max-Age=0",
      "old=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]) headers.append("Set-Cookie", value)
    mockGetSession.mockResolvedValue(Response.json(authenticated ? { user: { id: "u_1" }, session: { token: "sess_tok" } } : null, { headers }))
    const result = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(result.status).toBe(authenticated ? 200 : 401)
    expect(result.headers.getSetCookie()).toEqual(headers.getSetCookie())
    if (!authenticated) expect(await result.text()).toBe("Unauthorized")
  })

  it.each([401, 403, 500])("returns the SDK%s response with its original error body and clear cookies", async (status) => {
    const headers = new Headers()
    headers.append("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0")
    headers.append("Set-Cookie", "cache=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    const response = Response.json({ code: "FIXTURE_AUTH_ERROR", message: "fixture response" }, { status, headers })
    mockGetSession.mockResolvedValue(response)
    const result = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(result).toBe(response)
    expect(result.status).toBe(status)
    expect(result.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(await result.json()).toEqual({ code: "FIXTURE_AUTH_ERROR", message: "fixture response" })
  })

  it("preserves configured local port discovery", async () => {
    mockEnv.current = { DEV_WS_DO_URL: "ws://localhost:9123" }
    mockGetSession.mockResolvedValue(Response.json({ user: { id: "u_1" }, session: { token: "sess_tok" } }))
    const response = await GET(new NextRequest("http://localhost/api/ws/token"))
    expect(await response.json()).toEqual({ userId: "u_1", token: "sess_tok", wsPort: 9123 })
  })
})
