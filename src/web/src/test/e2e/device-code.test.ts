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
    if (res.status !== 200) {
      const text = await res.text()
      console.error("device/code error response:", res.status, text)
    }
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
      headers: { "Content-Type": "application/json", Origin: APP_URL },
      body: JSON.stringify({ userCode }),
    })
    expect(approveRes.status).toBe(200)

    // Wait for polling interval to elapse (plugin enforces 5s minimum between polls)
    await new Promise(r => setTimeout(r, 5100))

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
      headers: { "Content-Type": "application/json", Origin: APP_URL },
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
      headers: { "Content-Type": "application/json", Origin: APP_URL },
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
      sql(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${testEmail}')`)
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

describe("device-code-flow workspace reuse", () => {
  const wsTestEmail = `e2e_dcws_${randomUUID().slice(0, 8)}@test.local`
  const wsTestPassword = "TestPassword123!"
  let wsCookie: string
  let originalWorkspaceId: string

  beforeAll(async () => {
    await signUp(wsTestEmail, wsTestPassword, "E2E WS User")
    wsCookie = await signIn(wsTestEmail, wsTestPassword)

    // Create a workspace (simulates what the web app does on first visit)
    const wsRes = await sessionRequest("/api/workspaces", wsCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Personal", slug: `personal-${randomUUID().slice(0, 8)}` }),
    })
    expect(wsRes.status).toBe(201)
    const wsData = await wsRes.json() as Record<string, unknown>
    originalWorkspaceId = wsData.id as string
  })

  it("CLI login reuses existing workspace instead of creating a duplicate", async () => {
    // Request device code
    const codeRes = await fetch(`${APP_URL}/api/auth/device/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
    })
    expect(codeRes.status).toBe(200)
    const codeData = await codeRes.json() as Record<string, unknown>
    const dc = codeData.device_code as string
    const uc = codeData.user_code as string

    // Claim code to user session
    await sessionRequest(`/api/auth/device?user_code=${uc}`, wsCookie)

    // Approve
    const approveRes = await sessionRequest("/api/auth/device/approve", wsCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP_URL },
      body: JSON.stringify({ userCode: uc }),
    })
    expect(approveRes.status).toBe(200)

    // Wait for polling interval
    await new Promise(r => setTimeout(r, 5100))

    // Get token
    const tokenRes = await fetch(`${APP_URL}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dc,
        client_id: TEST_CLIENT_ID,
      }),
    })
    expect(tokenRes.status).toBe(200)
    const tokenData = await tokenRes.json() as Record<string, unknown>
    const accessToken = tokenData.access_token as string

    // CLI flow: get existing workspaces (use session cookie — mirrors real CLI which
    // uses the session token via bearer() but cookie auth is equivalent here)
    const wsListRes = await sessionRequest("/api/workspaces", wsCookie)
    const wsList = await wsListRes.json() as { id: string }[]
    expect(wsList.length).toBeGreaterThanOrEqual(1)
    expect(wsList[0].id).toBe(originalWorkspaceId)

    // Create machine token tied to existing workspace (use Bearer session token)
    const mtRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${originalWorkspaceId}`,
      accessToken,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    )
    expect(mtRes.status).toBeLessThan(300)
    const mtData = await mtRes.json() as Record<string, unknown>
    const machineToken = mtData.token as string
    expect(machineToken).toBeTruthy()

    // Activate with the machine token
    const activateRes = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: machineToken,
        hostname: "e2e-test-host",
        runtimes: [{ type: "claude", version: "4.0.0" }],
      }),
    })
    expect(activateRes.status).toBe(200)
    const activateBody = await activateRes.json() as Record<string, unknown>
    expect(activateBody.workspace_id).toBe(originalWorkspaceId)

    // Verify user still has exactly 1 workspace
    const wsAfterRes = await sessionRequest("/api/workspaces", wsCookie)
    const wsAfter = await wsAfterRes.json() as { id: string }[]
    expect(wsAfter).toHaveLength(1)
    expect(wsAfter[0].id).toBe(originalWorkspaceId)
  })

  afterAll(() => {
    try {
      sql(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${wsTestEmail}')`)
      sql(`DELETE FROM machine_token WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${wsTestEmail}')`)
      sql(`DELETE FROM agent_runtime WHERE machine_id IN (SELECT id FROM machine WHERE workspace_id = '${originalWorkspaceId}')`)
      sql(`DELETE FROM machine WHERE workspace_id = '${originalWorkspaceId}'`)
      sql(`DELETE FROM member WHERE workspace_id = '${originalWorkspaceId}'`)
      sql(`DELETE FROM workspace WHERE id = '${originalWorkspaceId}'`)
      sql(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${wsTestEmail}')`)
      sql(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = '${wsTestEmail}')`)
      sql(`DELETE FROM "user" WHERE email = '${wsTestEmail}'`)
    } catch { /* ignore cleanup errors */ }
  })
})
