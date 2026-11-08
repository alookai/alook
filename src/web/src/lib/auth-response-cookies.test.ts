import rawContractInput0 from "../../migrations/0001_schema.sql?raw"
import rawContractInput1 from "../../migrations/0035_device_code_table.sql?raw"
import { DatabaseSync } from "node:sqlite"
import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createAuth, observeAuthSession } from "./auth"
import { browserCookieHeaders } from "@/test/browser-cookie-jar"

const secret = "fixture-only-navigation-session-secret-163"
afterEach(() => vi.restoreAllMocks())

describe("independent-request signed session refresh", () => {

  it("uses real BetterAuth and SQLite to avoid a second lookup after an expired cache refresh", async () => {
    const sqlite = new DatabaseSync(":memory:")
    try {
      sqlite.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, emailVerified INTEGER, image TEXT, createdAt INTEGER, updatedAt INTEGER, discriminator TEXT, isBot INTEGER, deletedAt TEXT);
        CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT, userId TEXT, expiresAt INTEGER, createdAt INTEGER, updatedAt INTEGER, ipAddress TEXT, userAgent TEXT);`)
      sqlite.exec(rawContractInput0)
      sqlite.exec(rawContractInput1)
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
      const cached = browserCookieHeaders(first.headers, initial.headers).get("Cookie")!
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
      const forwarded = browserCookieHeaders(stale.headers, refresh.headers)
      const session = await auth.api.getSession({ headers: new Headers({ Cookie: forwarded.get("Cookie")! }) })
      expect(session?.user.id).toBe("viewer-a")
      expect(find).toHaveBeenCalledTimes(2)
      const absent = await auth.api.getSession({ headers: new Headers() })
      expect(absent).toBeNull()
      const onlyCache = new NextRequest(stale, { headers: { Cookie: forwarded.get("Cookie")! } })
      onlyCache.cookies.delete(context.authCookies.sessionToken.name)
      expect(await auth.api.getSession({ headers: onlyCache.headers })).toBeNull()
      sqlite.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("viewer-b", "Other", "other@example.test", 1, null, new Date(now).toISOString(), new Date(now).toISOString(), "0002", 0, null)
      sqlite.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-b", "other-token", "viewer-b", new Date(now + 30 * 86400000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), null, null)
      const otherSigned = encodeURIComponent("other-token." + createHmac("sha256", secret).update("other-token").digest("base64"))
      const otherRequest = new NextRequest(first, { headers: { Cookie: `${context.authCookies.sessionToken.name}=${otherSigned}` } })
      const [a, b] = await Promise.all([
        auth.api.getSession({ headers: new Headers({ Cookie: forwarded.get("Cookie")! }) }),
        auth.api.getSession({ headers: otherRequest.headers, returnHeaders: true }),
      ])
      expect(a?.user.id).toBe("viewer-a")
      expect(b.response?.user.id).toBe("viewer-b")
      const otherForwarded = browserCookieHeaders(otherRequest.headers, b.headers)
      expect((await auth.api.getSession({ headers: new Headers({ Cookie: otherForwarded.get("Cookie")! }) }))?.user.id).toBe("viewer-b")
    } finally { sqlite.close() }
  })
})
