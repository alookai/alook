/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers"
import { applySetCookies } from "better-auth/cookies"
import { makeSignature } from "better-auth/crypto"
import { afterEach, describe, expect, it } from "vitest"
import { createAuth, getAuth } from "../src/lib/auth"

const runtimeEnv = env as unknown as CloudflareEnv
const users: string[] = []

afterEach(async () => {
  for (const id of users.splice(0)) {
    await runtimeEnv.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(id).run()
  }
})

async function seedSession() {
  const id = crypto.randomUUID()
  const token = crypto.randomUUID()
  const now = new Date().toISOString()
  users.push(id)
  await runtimeEnv.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).bind(id, `Auth ${id}`, `${id}@example.test`, now, now).run()
  await runtimeEnv.DB.prepare(
    'INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(crypto.randomUUID(), id, token, new Date(Date.now() + 3_600_000).toISOString(), now, now).run()
  return { id, token }
}

function authEnvironment(statements: string[]): Env {
  const DB = new Proxy(runtimeEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (statement: string) => {
          statements.push(statement)
          if (/\b(?:sqlite_master|sqlite_schema|pragma_table_info|pragma_index_list|pragma_index_info)\b|\bPRAGMA\s+(?:table_info|index_list|index_info)\b/i.test(statement)) {
            throw new Error("Auth requests must not introspect the database schema")
          }
          return target.prepare(statement)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return {
    ...runtimeEnv,
    NODE_ENV: "production",
    DB,
    BETTER_AUTH_URL: "https://auth-runtime.test",
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    CF_VERSION_METADATA: { id: crypto.randomUUID(), tag: "", timestamp: new Date().toISOString() },
  }
}

describe("Auth sessions without runtime schema introspection", () => {
  it("validates and refreshes sessions in independently constructed Auth instances", async () => {
    const user = await seedSession()
    const statements: string[] = []
    const authEnv = authEnvironment(statements)
    for (const auth of [createAuth(authEnv), createAuth(authEnv)]) {
      const context = await auth.$context
      const signed = encodeURIComponent(`${user.token}.${await makeSignature(user.token, authEnv.BETTER_AUTH_SECRET)}`)
      const headers = new Headers({ cookie: `${context.authCookies.sessionToken.name}=${signed}` })
      const result = await auth.api.getSession({
        headers,
        returnHeaders: true,
      })
      expect(result.response?.user.id).toBe(user.id)
      expect(result.headers.getSetCookie().some((cookie) => cookie.includes("session_data="))).toBe(true)

      const forwarded = new Headers(headers)
      applySetCookies(forwarded, result.headers.getSetCookie())
      expect((await auth.api.getSession({ headers: forwarded }))?.user.id).toBe(user.id)
    }
    expect(statements.some((statement) => /\bFROM\s+"session"/i.test(statement))).toBe(true)
  })

  it("isolates concurrent users and rejects missing, invalid, and expired sessions on one reused instance", async () => {
    const first = await seedSession()
    const second = await seedSession()
    const expired = await seedSession()
    await runtimeEnv.DB.prepare('UPDATE "session" SET expiresAt = ? WHERE token = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), expired.token).run()
    const statements: string[] = []
    const authEnv = authEnvironment(statements)
    const auth = getAuth(authEnv)
    expect(getAuth({ ...authEnv })).toBe(auth)
    const results = await Promise.all([first.token, second.token, undefined, "invalid-session-token", expired.token].map((token) =>
      auth.api.getSession({ headers: new Headers(token ? { authorization: `Bearer ${token}` } : {}) }),
    ))
    expect(results.map((result) => result?.user.id ?? null)).toEqual([first.id, second.id, null, null, null])
  })
})
