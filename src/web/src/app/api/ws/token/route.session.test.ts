import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getAuth } from "@/lib/auth"
import { authResponseCookies } from "@/lib/auth-response-cookies"

const environment = vi.hoisted(() => ({ current: {} as Env }))
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ env: environment.current }) }))
import { GET } from "./route"

const secret = "fixture-only-ws-cookie-session-secret-192"
const token = "fixture-only-ws-session-token-192"
let database: DatabaseSync
let now: number
let version = 0

beforeEach(() => {
  now = Date.now()
  database = new DatabaseSync(":memory:")
  database.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, createdAt INTEGER, updatedAt INTEGER, discriminator TEXT, isBot INTEGER, deletedAt TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT, userId TEXT, expiresAt INTEGER, createdAt INTEGER, updatedAt INTEGER, ipAddress TEXT, userAgent TEXT);`)
  database.exec(readFileSync(new URL("../../../../../migrations/0001_schema.sql", import.meta.url), "utf8"))
  database.exec(readFileSync(new URL("../../../../../migrations/0035_device_code_table.sql", import.meta.url), "utf8"))
  database.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("viewer-192", "Fixture", "ws-fixture@example.test", 1, null, new Date(now).toISOString(), new Date(now).toISOString(), "0001", 0, null)
  database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("session-192", token, "viewer-192", new Date(now + 30 * 86_400_000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), null, null)
  environment.current = {
    DB: database,
    NODE_ENV: "production",
    BETTER_AUTH_URL: "https://fixture.test",
    BETTER_AUTH_SECRET: secret,
    CF_VERSION_METADATA: { id: `fixture-ws-192-${++version}`, tag: "fixture", timestamp: new Date(now).toISOString() },
  } as unknown as Env
  return () => { vi.restoreAllMocks(); database.close() }
})

async function sessionFixture() {
  const auth = getAuth(environment.current)
  const context = await auth.$context
  const signed = encodeURIComponent(token + "." + createHmac("sha256", secret).update(token).digest("base64"))
  const headers = new Headers({ Cookie: `${context.authCookies.sessionToken.name}=${signed}` })
  const lookup = context.internalAdapter.findSession.bind(context.internalAdapter)
  return { auth, context, headers, lookup, find: vi.spyOn(context.internalAdapter, "findSession") }
}

function nextHeaders(headers: Headers, response: Response) {
  const forwarded = authResponseCookies(new NextRequest("https://fixture.test/api/ws/token", { headers }), response.headers)
  const cookie = forwarded.headers.get("x-middleware-request-cookie")
  return cookie === null ? new Headers(headers) : new Headers({ Cookie: cookie })
}

function request(headers: Headers, refresh = false) {
  return new NextRequest(`https://fixture.test/api/ws/token${refresh ? "?refresh=1" : ""}`, { headers })
}

describe("real token-route session cookie roundtrip", () => {
  it("returns the expired-cache refresh and restores the next-request fast path while the omitted-cookie control repeats storage", async () => {
    const fixture = await sessionFixture()
    expect(fixture.context.options.session?.cookieCache?.maxAge).toBe(300)
    const initial = await GET(request(fixture.headers))
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ userId: "viewer-192", token })
    expect(fixture.find).toHaveBeenCalledOnce()
    expect(initial.headers.getSetCookie().some(value => value.startsWith(fixture.context.authCookies.sessionData.name + "=") && /max-age=300/i.test(value))).toBe(true)
    const cached = nextHeaders(fixture.headers, initial)
    fixture.find.mockClear()
    expect((await GET(request(cached))).status).toBe(200)
    expect(fixture.find).not.toHaveBeenCalled()
    vi.spyOn(Date, "now").mockReturnValue(now + 301_000)
    const refresh = await GET(request(cached))
    expect(refresh.status).toBe(200)
    expect(fixture.find).toHaveBeenCalledOnce()
    expect(refresh.headers.getSetCookie().some(value => /max-age=300/i.test(value))).toBe(true)
    const omitted = await GET(request(cached))
    expect(omitted.status).toBe(200)
    expect(fixture.find).toHaveBeenCalledTimes(2)
    const recovered = await GET(request(nextHeaders(cached, refresh)))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({ userId: "viewer-192", token })
    expect(fixture.find).toHaveBeenCalledTimes(2)
  })

  it("preserves the ordinary signed-cache contract but clears a revoked session through one authoritative refresh", async () => {
    const fixture = await sessionFixture()
    const initial = await GET(request(fixture.headers))
    const cached = nextHeaders(fixture.headers, initial)
    database.prepare("DELETE FROM session WHERE token = ?").run(token)
    fixture.find.mockClear()
    expect((await GET(request(cached))).status).toBe(200)
    expect(fixture.find).not.toHaveBeenCalled()
    const denied = await GET(request(cached, true))
    expect(denied.status).toBe(401)
    expect(await denied.text()).toBe("Unauthorized")
    expect(fixture.find).toHaveBeenCalledOnce()
    const deleted = denied.headers.getSetCookie()
    expect(deleted.some(value => value.startsWith(fixture.context.authCookies.sessionToken.name + "=") && /max-age=0/i.test(value))).toBe(true)
    expect(deleted.some(value => value.startsWith(fixture.context.authCookies.sessionData.name + "=") && /max-age=0/i.test(value))).toBe(true)
    const cleared = nextHeaders(cached, denied)
    expect(new NextRequest("https://fixture.test", { headers: cleared }).cookies.has(fixture.context.authCookies.sessionToken.name)).toBe(false)
    expect((await GET(request(cleared))).status).toBe(401)
    expect(fixture.find).toHaveBeenCalledOnce()
  })

  it("clears an actually expired stored session on the null response path", async () => {
    const fixture = await sessionFixture()
    database.prepare("UPDATE session SET expiresAt = ? WHERE token = ?").run(new Date(now - 1).toISOString(), token)
    const denied = await GET(request(fixture.headers))
    expect(denied.status).toBe(401)
    expect(fixture.find).toHaveBeenCalledOnce()
    expect(denied.headers.getSetCookie().some(value => value.startsWith(fixture.context.authCookies.sessionToken.name + "=") && /max-age=0/i.test(value))).toBe(true)
    expect((await GET(request(nextHeaders(fixture.headers, denied)))).status).toBe(401)
    expect(fixture.find).toHaveBeenCalledOnce()
  })

  it("forwards the real SDK error and deletion cookies when a stored session disappears between lookup and refresh", async () => {
    const fixture = await sessionFixture()
    database.prepare("UPDATE session SET expiresAt = ?, updatedAt = ? WHERE token = ?")
      .run(new Date(now + 28 * 86_400_000).toISOString(), new Date(now - 2 * 86_400_000).toISOString(), token)
    fixture.find.mockImplementationOnce(async (...args) => {
      const current = await fixture.lookup(...args)
      database.prepare("DELETE FROM session WHERE token = ?").run(token)
      return current
    })
    const update = vi.spyOn(fixture.context.internalAdapter, "updateSession")
    const denied = await GET(request(fixture.headers))
    expect(denied.status).toBe(401)
    expect(await denied.json()).toMatchObject({ code: "FAILED_TO_GET_SESSION" })
    expect(fixture.find).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(denied.headers.getSetCookie().some(value => value.startsWith(fixture.context.authCookies.sessionToken.name + "=") && /max-age=0/i.test(value))).toBe(true)
    expect(denied.headers.getSetCookie().some(value => value.startsWith(fixture.context.authCookies.sessionData.name + "=") && /max-age=0/i.test(value))).toBe(true)
    expect((await GET(request(nextHeaders(fixture.headers, denied)))).status).toBe(401)
    expect(fixture.find).toHaveBeenCalledOnce()
  })
})
