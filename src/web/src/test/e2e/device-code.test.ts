import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, tokenRequest } from "../helpers/auth"
import { sql } from "../helpers/db"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const TEST_CLIENT_ID = "e2e-test-client"

const testEmail = `e2e_device_${randomUUID().slice(0, 8)}@test.local`
const testPassword = "TestPassword123!"
const testName = "E2E Device User"

let sessionCookie: string

describe("device-code-flow", () => {
  beforeAll(async () => {
    await signUp(testEmail, testPassword, testName)
    sessionCookie = await signIn(testEmail, testPassword)
  })

  let deviceCode: string
  let userCode: string

  it("POST /api/auth/device/code returns device_code, user_code, and verification URLs", async () => {
    const res = await fetch(`${APP_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as Record<string, unknown>
    expect(data.device_code).toBeTruthy()
    expect(data.user_code).toBeTruthy()
    expect(data.verification_uri).toBeTruthy()
    expect(data.verification_uri_complete).toBeTruthy()
    expect(data.expires_in).toBeGreaterThan(0)
    expect(data.interval).toBeDefined()
    deviceCode = data.device_code as string
    userCode = data.user_code as string
  })

  it("POST /api/auth/device/token returns authorization_pending before approval", async () => {
    const res = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: TEST_CLIENT_ID,
      }),
    })
    expect(res.status).toBe(400)
    const data = await res.json() as Record<string, unknown>
    expect(data.error).toBe("authorization_pending")
  })

  it("GET /api/auth/device claims code to authenticated user session", async () => {
    const res = await sessionRequest(
      `/api/auth/device?user_code=${userCode}`,
      sessionCookie,
    )
    expect(res.status).toBe(200)
  })

  it("POST /api/auth/device/approve approves the device and token poll succeeds", async () => {
    const approveRes = await sessionRequest("/api/auth/device/approve", sessionCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode }),
    })
    expect(approveRes.status).toBe(200)

    const tokenRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: TEST_CLIENT_ID,
      }),
    })
    expect(tokenRes.status).toBe(200)
    const data = await tokenRes.json() as Record<string, unknown>
    expect(data.access_token).toBeTruthy()
    expect(data.token_type).toBe("Bearer")
  })

  it("access_token from device flow works as Bearer token for API calls", async () => {
    // Get a fresh token via a new flow
    const codeRes = await fetch(`${APP_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
    })
    const codeData = await codeRes.json() as Record<string, unknown>
    const dc = codeData.device_code as string
    const uc = codeData.user_code as string

    await sessionRequest(`/api/auth/device?user_code=${uc}`, sessionCookie)
    await sessionRequest("/api/auth/device/approve", sessionCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: uc }),
    })

    const tokenRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc,
        client_id: TEST_CLIENT_ID,
      }),
    })
    const tokenData = await tokenRes.json() as Record<string, unknown>
    const accessToken = tokenData.access_token as string

    const meRes = await tokenRequest("/api/me", accessToken)
    expect(meRes.status).toBe(200)
    const me = await meRes.json() as Record<string, unknown>
    expect(me.email).toBe(testEmail)
  })

  it("POST /api/auth/device/deny denies authorization and token poll returns access_denied", async () => {
    const codeRes = await fetch(`${APP_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
    })
    const codeData = await codeRes.json() as Record<string, unknown>
    const dc = codeData.device_code as string
    const uc = codeData.user_code as string

    await sessionRequest(`/api/auth/device?user_code=${uc}`, sessionCookie)
    await sessionRequest("/api/auth/device/deny", sessionCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: uc }),
    })

    const tokenRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc,
        client_id: TEST_CLIENT_ID,
      }),
    })
    const data = await tokenRes.json() as Record<string, unknown>
    expect(data.error).toBe("access_denied")
  })

  afterAll(() => {
    try {
      sql(`DELETE FROM device_code WHERE user_id IN (SELECT id FROM "user" WHERE email = '${testEmail}')`)
      sql(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${testEmail}')`)
      sql(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${testEmail}')`)
      sql(`DELETE FROM "user" WHERE email = '${testEmail}'`)
    } catch { /* ignore cleanup errors */ }
  })
})

describe("onboard.md", () => {
  it("GET /onboard.md returns markdown with correct content-type", async () => {
    const res = await fetch(`${APP_URL}/onboard.md`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const body = await res.text()
    expect(body).toContain("npx @alook/cli login")
    expect(body).toContain("npx @alook/cli daemon start")
  })
})
