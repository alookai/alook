import { DatabaseSync } from "node:sqlite"
import { readFileSync } from "node:fs"
import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createAuth, observeAuthSession } from "./auth"
import { authResponseCookies } from "./auth-response-cookies"

const secret = "fixture-only-navigation-session-secret-163"
afterEach(() => vi.restoreAllMocks())

describe("same-request signed session refresh", () => {
  it("leaves requests without a refresh on the original Next pass-through path", () => {
    const response = authResponseCookies(new NextRequest("https://fixture.test/c", { headers: { Cookie: "session=signed" } }), new Headers())
    expect(response.headers.get("x-middleware-next")).toBe("1")
    expect(response.headers.has("x-middleware-override-headers")).toBe(false)
    expect(response.headers.getSetCookie()).toEqual([])
  })
  it.each([false, true])("keeps the original streamed POST readable with refresh=%s", async (refresh) => {
    const payload = '{"message":"fixture body 中文"}'
    const bytes = new TextEncoder().encode(payload)
    const request = new NextRequest("https://fixture.test/c/channels/server/conversation", {
      method: "POST", headers: { Cookie: "session=old; expired=old; preference=keep", "Content-Type": "application/json" },
      body: new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 9))
        controller.enqueue(bytes.subarray(9))
        controller.close()
      } }),
    })
    const body = request.body!
    const clone = vi.spyOn(request, "clone")
    const reader = vi.spyOn(body, "getReader")
    const headers = new Headers()
    if (refresh) {
      headers.append("Set-Cookie", "session=refreshed; HttpOnly; Path=/; Max-Age=300")
      headers.append("Set-Cookie", "expired=; HttpOnly; Path=/; Max-Age=0")
    }
    expect(body.locked).toBe(false)
    expect(request.bodyUsed).toBe(false)
    const response = authResponseCookies(request, headers)
    expect(request.method).toBe("POST")
    expect(request.body).toBe(body)
    expect(body.locked).toBe(false)
    expect(request.bodyUsed).toBe(false)
    expect(clone).not.toHaveBeenCalled()
    expect(reader).not.toHaveBeenCalled()
    expect(request.headers.get("Cookie")).toBe("session=old; expired=old; preference=keep")
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    if (refresh) {
      expect(response.headers.get("x-middleware-request-cookie")).toBe("session=refreshed; preference=keep")
      expect(response.headers.get("x-middleware-request-content-type")).toBe("application/json")
    } else expect(response.headers.has("x-middleware-override-headers")).toBe(false)
    expect(await request.text()).toBe(payload)
  })
  it("preserves chunk updates, deletes expired chunks and returns every Set-Cookie", () => {
    const request = new NextRequest("https://fixture.test/c", { headers: { Cookie: "session=old; cache.0=old; cache.1=tail; preference=keep" } })
    const headers = new Headers()
    headers.append("Set-Cookie", "cache.0=new; HttpOnly; Path=/; Max-Age=300")
    headers.append("Set-Cookie", "cache.1=; HttpOnly; Path=/; Max-Age=0")
    headers.append("Set-Cookie", "session=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    headers.append("Set-Cookie", "maxAgeWins=signed%2Fbytes%3D; Path=/; Max-Age=300; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    const response = authResponseCookies(request, headers)
    const forwarded = new NextRequest(request, { headers: { Cookie: response.headers.get("x-middleware-request-cookie")! } })
    expect(forwarded.cookies.get("cache.0")?.value).toBe("new")
    expect(forwarded.cookies.has("cache.1")).toBe(false)
    expect(forwarded.cookies.has("session")).toBe(false)
    expect(forwarded.cookies.get("preference")?.value).toBe("keep")
    expect(response.headers.get("x-middleware-request-cookie")).toContain("maxAgeWins=signed%2Fbytes%3D")
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie())
    expect(request.cookies.get("session")?.value).toBe("old")
  })

  it("uses real BetterAuth and SQLite to avoid a second lookup after an expired cache refresh", async () => {
    const sqlite = new DatabaseSync(":memory:")
    try {
      sqlite.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, createdAt INTEGER, updatedAt INTEGER, discriminator TEXT, isBot INTEGER, deletedAt TEXT);
        CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT, userId TEXT, expiresAt INTEGER, createdAt INTEGER, updatedAt INTEGER, ipAddress TEXT, userAgent TEXT);`)
      sqlite.exec(readFileSync(new URL("../../migrations/0001_schema.sql", import.meta.url), "utf8"))
      sqlite.exec(readFileSync(new URL("../../migrations/0035_device_code_table.sql", import.meta.url), "utf8"))
      const now = Date.now()
      sqlite.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("viewer-a", "Viewer", "fixture@example.test", 1, null, new Date(now).toISOString(), new Date(now).toISOString(), "0001", 0, null)
      sqlite.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-a", "fixture-token", "viewer-a", new Date(now + 30 * 86400000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), null, null)
      const auth = createAuth({ DB: sqlite, NODE_ENV: "production", BETTER_AUTH_URL: "https://fixture.test", BETTER_AUTH_SECRET: secret } as unknown as Env)
      const context = await auth.$context
      const find = vi.spyOn(context.internalAdapter, "findSession")
      const signed = encodeURIComponent("fixture-token." + createHmac("sha256", secret).update("fixture-token").digest("base64"))
      const first = new NextRequest("https://fixture.test/c", { headers: { Cookie: `${context.authCookies.sessionToken.name}=${signed}` } })
      let ready!: (value: typeof context) => void
      const pendingContext = new Promise<typeof context>(resolve => { ready = resolve })
      const execute = vi.fn(() => auth.api.getSession({ headers: first.headers, returnHeaders: true }))
      const pendingSession = observeAuthSession({ ...auth, $context: pendingContext }, execute)
      await Promise.resolve()
      expect(execute).not.toHaveBeenCalled()
      ready(context)
      const initial = await pendingSession
      expect(execute).toHaveBeenCalledOnce()
      const sessionFailure = new Error("fixture session failure")
      await expect(observeAuthSession(auth, () => Promise.reject(sessionFailure))).rejects.toBe(sessionFailure)
      const contextFailure = new Error("fixture context failure")
      const blocked = vi.fn(() => auth.api.getSession({ headers: first.headers }))
      await expect(observeAuthSession({ ...auth, $context: Promise.reject(contextFailure) }, blocked)).rejects.toBe(contextFailure)
      expect(blocked).not.toHaveBeenCalled()
      expect(initial.response?.user.id).toBe("viewer-a")
      expect(find).toHaveBeenCalledTimes(1)
      const cached = authResponseCookies(first, initial.headers).headers.get("x-middleware-request-cookie")!
      find.mockClear()
      await auth.api.getSession({ headers: new Headers({ Cookie: cached }) })
      expect(find).not.toHaveBeenCalled()
      vi.spyOn(Date, "now").mockReturnValue(now + 301000)
      const stale = new NextRequest(first, { headers: { Cookie: cached } })
      const refresh = await auth.api.getSession({ headers: stale.headers, returnHeaders: true })
      expect(refresh.response?.user.id).toBe("viewer-a")
      expect(find).toHaveBeenCalledTimes(1)
      await auth.api.getSession({ headers: stale.headers })
      expect(find).toHaveBeenCalledTimes(2)
      const forwarded = authResponseCookies(stale, refresh.headers)
      const session = await auth.api.getSession({ headers: new Headers({ Cookie: forwarded.headers.get("x-middleware-request-cookie")! }) })
      expect(session?.user.id).toBe("viewer-a")
      expect(find).toHaveBeenCalledTimes(2)
      const absent = await auth.api.getSession({ headers: new Headers() })
      expect(absent).toBeNull()
      const onlyCache = new NextRequest(stale, { headers: { Cookie: forwarded.headers.get("x-middleware-request-cookie")! } })
      onlyCache.cookies.delete(context.authCookies.sessionToken.name)
      expect(await auth.api.getSession({ headers: onlyCache.headers })).toBeNull()
      sqlite.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("viewer-b", "Other", "other@example.test", 1, null, new Date(now).toISOString(), new Date(now).toISOString(), "0002", 0, null)
      sqlite.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-b", "other-token", "viewer-b", new Date(now + 30 * 86400000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), null, null)
      const otherSigned = encodeURIComponent("other-token." + createHmac("sha256", secret).update("other-token").digest("base64"))
      const otherRequest = new NextRequest(first, { headers: { Cookie: `${context.authCookies.sessionToken.name}=${otherSigned}` } })
      const [a, b] = await Promise.all([
        auth.api.getSession({ headers: new Headers({ Cookie: forwarded.headers.get("x-middleware-request-cookie")! }) }),
        auth.api.getSession({ headers: otherRequest.headers, returnHeaders: true }),
      ])
      expect(a?.user.id).toBe("viewer-a")
      expect(b.response?.user.id).toBe("viewer-b")
      const otherForwarded = authResponseCookies(otherRequest, b.headers)
      expect((await auth.api.getSession({ headers: new Headers({ Cookie: otherForwarded.headers.get("x-middleware-request-cookie")! }) }))?.user.id).toBe("viewer-b")
    } finally { sqlite.close() }
  })
})
