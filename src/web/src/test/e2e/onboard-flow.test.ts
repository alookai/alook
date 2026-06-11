import { describe, it, expect, beforeAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, tokenRequest, sqlRun, sqlQuery } from "@alook/test-utils"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const TEST_CLIENT_ID = "e2e-test-client"

async function deviceCodeLogin(sessionCookie: string): Promise<string> {
  const codeRes = await fetch(`${APP_URL}/api/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
  })
  const codeData = await codeRes.json() as { device_code: string; user_code: string }

  await sessionRequest(`/api/auth/device?user_code=${codeData.user_code}`, sessionCookie)
  await sessionRequest("/api/auth/device/approve", sessionCookie, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP_URL },
    body: JSON.stringify({ userCode: codeData.user_code }),
  })

  await new Promise(r => setTimeout(r, 5100))

  const tokenRes = await fetch(`${APP_URL}/api/auth/device/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: codeData.device_code,
      client_id: TEST_CLIENT_ID,
    }),
  })
  const tokenData = await tokenRes.json() as { access_token: string }
  return tokenData.access_token
}

describe("onboard flow — simplified model", () => {

  // Scenario 1: New user → create workspace → get token → activate → runtimes available
  describe("Scenario 1: New user complete onboard flow", () => {
    const email = `e2e_onboard_new_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let accessToken: string
    let workspaceId: string
    let machineToken: string

    beforeAll(async () => {
      await signUp(email, password, "E2E New User")
      sessionCookie = await signIn(email, password)
    })

    it("login via device code auth stores session token", async () => {
      accessToken = await deviceCodeLogin(sessionCookie)
      expect(accessToken).toBeTruthy()
      const meRes = await tokenRequest("/api/me", accessToken)
      expect(meRes.status).toBe(200)
    })

    it("new user has no workspaces initially", async () => {
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie)
      const workspaces = await wsRes.json() as Array<{ id: string }>
      expect(workspaces).toHaveLength(0)
    })

    it("create workspace", async () => {
      const res = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Personal", slug: `e2e-${randomUUID().slice(0, 8)}` }),
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { id: string }
      workspaceId = body.id
      expect(workspaceId).toBeTruthy()
    })

    it("create machine token for workspace", async () => {
      const res = await sessionRequest(
        `/api/machine-tokens?workspace_id=${workspaceId}`,
        sessionCookie,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
      )
      expect(res.status).toBe(201)
      const body = await res.json() as { token: string; status: string }
      machineToken = body.token
      expect(body.status).toBe("pending")
    })

    it("activate creates machine + runtime rows", async () => {
      const res = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: machineToken,
          hostname: "E2EMachine.local",
          runtimes: [{ type: "claude", version: "4.0.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json() as { workspace_id: string; runtimes: Array<{ id: string }> }
      expect(body.workspace_id).toBe(workspaceId)
      expect(body.runtimes.length).toBeGreaterThan(0)
    })

    it("runtimes are now available for the workspace", async () => {
      const res = await sessionRequest(`/api/runtimes?workspace_id=${workspaceId}`, sessionCookie)
      expect(res.status).toBe(200)
      const runtimes = await res.json() as Array<{ id: string; status: string }>
      expect(runtimes.length).toBeGreaterThan(0)
    })
  })

  // Scenario 2: Existing user, already has workspace with agents
  describe("Scenario 2: Existing user adds new workspace", () => {
    const email = `e2e_onboard_exist_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let existingWorkspaceId: string
    let newWorkspaceId: string

    beforeAll(async () => {
      await signUp(email, password, "E2E Existing User")
      sessionCookie = await signIn(email, password)

      const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Existing", slug: `e2e-exist-${randomUUID().slice(0, 8)}` }),
      })
      const ws = await wsRes.json() as { id: string }
      existingWorkspaceId = ws.id
    })

    it("can create a second workspace", async () => {
      const res = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Second WS", slug: `e2e-new-${randomUUID().slice(0, 8)}` }),
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { id: string }
      newWorkspaceId = body.id
    })

    it("token for new workspace can be activated independently", async () => {
      const tokenRes = await sessionRequest(
        `/api/machine-tokens?workspace_id=${newWorkspaceId}`,
        sessionCookie,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "cli" }) },
      )
      const { token } = await tokenRes.json() as { token: string }

      const activateRes = await fetch(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, hostname: "Machine2.local", runtimes: [{ type: "claude", version: "4.0" }] }),
      })
      expect(activateRes.status).toBe(200)
      const body = await activateRes.json() as { workspace_id: string }
      expect(body.workspace_id).toBe(newWorkspaceId)
    })
  })
})
