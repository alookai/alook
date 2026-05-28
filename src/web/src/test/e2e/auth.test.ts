import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, sqlRun } from "@alook/test-utils"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"

const testEmail = `e2e_auth_${randomUUID().slice(0, 8)}@test.local`
const testPassword = "TestPassword123!"
const testName = "E2E Auth User"

describe("auth", () => {
  it("POST /api/auth/sign-up/email creates a user", async () => {
    const res = await signUp(testEmail, testPassword, testName)
    expect([200, 201]).toContain(res.status)
  })

  it("POST /api/auth/sign-in/email returns a session cookie", async () => {
    const cookie = await signIn(testEmail, testPassword)
    expect(cookie).toBeTruthy()
    expect(cookie).toContain("=")
  })

  it("GET /api/me with session cookie returns user profile", async () => {
    const cookie = await signIn(testEmail, testPassword)
    const res = await sessionRequest("/api/me", cookie)
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.email).toBe(testEmail)
    expect(data.name).toBe(testName)
  })

  it("GET /api/me without auth returns 401", async () => {
    const res = await fetch(`${APP_URL}/api/me`)
    expect(res.status).toBe(401)
  })

  // Cleanup: remove test user created by sign-up
  afterAll(() => {
    try {
      sqlRun(`DELETE FROM "session" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
      sqlRun(`DELETE FROM "account" WHERE userId IN (SELECT id FROM "user" WHERE email = ?)`, testEmail)
      sqlRun(`DELETE FROM "user" WHERE email = ?`, testEmail)
    } catch { /* ignore cleanup errors */ }
  })
})
