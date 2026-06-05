import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { signUp, signIn, sessionRequest, tokenRequest, sqlRun, sqlQuery, fetchWithRetry } from "@alook/test-utils"

const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const TEST_CLIENT_ID = "e2e-test-client"

function genTokenId() { return `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}` }
function genToken() { return `al_${randomUUID().replace(/-/g, "")}` }

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

describe("onboard flow — user scenarios", () => {

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1: Brand-new user complete onboard flow
  // login → session token stored → no workspace → daemon standby →
  // workspace init → create workspace + bind → studio success
  // ─────────────────────────────────────────────────────────────────────────
  describe("Scenario 1: New user complete onboard flow", () => {
    const email = `e2e_onboard_new_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let accessToken: string
    let machineToken: string
    let machineTokenId: string
    let workspaceId: string

    beforeAll(async () => {
      await signUp(email, password, "E2E New User")
      sessionCookie = await signIn(email, password)
    })

    it("login via device code auth stores session token", async () => {
      accessToken = await deviceCodeLogin(sessionCookie)
      expect(accessToken).toBeTruthy()

      // Verify session token works
      const meRes = await tokenRequest("/api/me", accessToken)
      expect(meRes.status).toBe(200)
      const me = await meRes.json() as { email: string }
      expect(me.email).toBe(email)
    })

    it("new user has no workspaces (only machine token, status: registered)", async () => {
      // Verify no workspaces exist
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie)
      expect(wsRes.status).toBe(200)
      const workspaces = await wsRes.json() as Array<{ id: string }>
      expect(workspaces).toHaveLength(0)

      // Create machine token (no workspace_id since none exist)
      const mtRes = await tokenRequest("/api/machine-tokens", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "new-user-device" }),
      })
      expect(mtRes.status).toBe(201)
      const mtData = await mtRes.json() as { token: string; id: string }
      machineToken = mtData.token
      machineTokenId = mtData.id

      // Activate → registered (no workspace binding yet)
      const activateRes = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: machineToken,
          hostname: "NewUserHost.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(activateRes.status).toBe(200)
      const activateData = await activateRes.json() as { token_status: string }
      expect(activateData.token_status).toBe("registered")
    })

    it("daemon start in standby mode (no workspace)", async () => {
      const res = await tokenRequest("/api/daemon/register", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daemon_id: "new-user-daemon",
          device_name: "NewUserHost.local",
          cli_version: "1.0.0",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { standby: boolean; runtimes: unknown[] }
      expect(data.standby).toBe(true)
      expect(data.runtimes).toEqual([])
    })

    it("workspace init creates new workspace + bind → runtimes available", async () => {
      // Create workspace
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "My First Company", slug: `first-co-${randomUUID().slice(0, 8)}` }),
      })
      expect(wsRes.status).toBe(201)
      const wsData = await wsRes.json() as { id: string; name: string }
      expect(wsData.id).toMatch(/^sp_/)
      workspaceId = wsData.id

      // Bind machine token to workspace
      const bindRes = await tokenRequest("/api/machine-tokens/bind-workspace", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      expect(bindRes.status).toBe(200)
      const bindData = await bindRes.json() as { workspace_id: string; runtimes: Array<{ id: string }> }
      expect(bindData.workspace_id).toBe(workspaceId)
      expect(bindData.runtimes.length).toBeGreaterThanOrEqual(1)
    })

    it("config updated: workspace entry has id (not null) and active status", async () => {
      // Verify token is now active with workspace
      const statusRes = await tokenRequest("/api/machine-tokens/status", machineToken)
      expect(statusRes.status).toBe(200)
      const statusData = await statusRes.json() as { status: string; workspace_id: string }
      expect(statusData.status).toBe("active")
      expect(statusData.workspace_id).toBe(workspaceId)
    })

    afterAll(() => {
      try {
        sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = 'NewUserHost.local' AND workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM machine WHERE daemon_id = 'NewUserHost.local' AND workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM machine_token WHERE id = ?`, machineTokenId)
        sqlRun(`DELETE FROM member WHERE workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM workspace WHERE id = ?`, workspaceId)
        sqlRun(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "user" WHERE email = ?`, email)
      } catch { /* ignore cleanup errors */ }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2: Existing user, new computer
  // Server already has workspace + agents.
  // login → session token + workspace syncs to config (status: active)
  // daemon start → normal registration (not standby)
  // workspace init → server has workspace with agents → create new workspace + bind
  // ─────────────────────────────────────────────────────────────────────────
  describe("Scenario 2: Existing user, new computer", () => {
    const email = `e2e_onboard_old_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let accessToken: string
    let existingWorkspaceId: string
    let newWorkspaceId: string
    let machineToken: string
    let machineTokenId: string

    beforeAll(async () => {
      await signUp(email, password, "E2E Existing User")
      sessionCookie = await signIn(email, password)

      // Create existing workspace (as if user already has one from web)
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Existing Co", slug: `existing-co-${randomUUID().slice(0, 8)}` }),
      })
      const wsData = await wsRes.json() as { id: string }
      existingWorkspaceId = wsData.id

      // Add an agent to the existing workspace (simulates existing setup)
      const userId = sqlQuery<{ id: string }>(`SELECT id FROM "user" WHERE email = ?`, email)[0]!.id
      const now = new Date().toISOString()
      const rtId = `rt_e2e_${Date.now()}`
      sqlRun(
        `INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rtId, existingWorkspaceId, "old-daemon", "local", "claude", "online", "old-device", now, now,
      )
      sqlRun(
        `INSERT INTO agent (id, workspace_id, name, runtime_id, email_handle, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        `ag_e2e_${Date.now()}`, existingWorkspaceId, "Existing Agent", rtId, "existing", userId, now, now,
      )
    })

    it("login syncs existing workspace to config (status: active)", async () => {
      accessToken = await deviceCodeLogin(sessionCookie)

      // After login, user's workspace list includes the existing workspace
      const wsListRes = await sessionRequest("/api/workspaces", sessionCookie)
      expect(wsListRes.status).toBe(200)
      const workspaces = await wsListRes.json() as Array<{ id: string; name: string }>
      expect(workspaces.length).toBeGreaterThanOrEqual(1)
      expect(workspaces.some(w => w.id === existingWorkspaceId)).toBe(true)
    })

    it("create machine token bound to existing workspace", async () => {
      const mtRes = await tokenRequest(
        `/api/machine-tokens?workspace_id=${existingWorkspaceId}`,
        accessToken,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      )
      expect(mtRes.status).toBeLessThan(300)
      const mtData = await mtRes.json() as { token: string; id: string }
      machineToken = mtData.token
      machineTokenId = mtData.id

      // Activate
      const activateRes = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: machineToken,
          hostname: "NewPC.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(activateRes.status).toBe(200)
    })

    it("daemon start → normal registration (not standby) since workspace exists", async () => {
      // Bind to workspace first
      const bindRes = await tokenRequest("/api/machine-tokens/bind-workspace", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: existingWorkspaceId }),
      })
      expect(bindRes.status).toBe(200)

      // Register daemon — should NOT be standby since token now has workspace
      const res = await tokenRequest("/api/daemon/register", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daemon_id: "NewPC.local",
          device_name: "NewPC.local",
          cli_version: "1.0.0",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { standby?: boolean; runtimes: Array<{ id: string }> }
      expect(data.standby).toBeFalsy()
      expect(data.runtimes.length).toBeGreaterThanOrEqual(1)
    })

    it("workspace init → existing workspace has agents → create new workspace + bind → studio succeeds", async () => {
      // Verify existing workspace has agents
      const agentsRes = await tokenRequest(
        `/api/agents?workspace_id=${existingWorkspaceId}`,
        machineToken,
      )
      expect(agentsRes.status).toBe(200)
      const existingAgents = await agentsRes.json() as Array<{ id: string }>
      expect(existingAgents.length).toBeGreaterThan(0)

      // CLI logic: workspace has agents → create new workspace instead
      const newWsRes = await tokenRequest("/api/workspaces", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Setup", slug: `new-setup-${randomUUID().slice(0, 8)}` }),
      })
      expect(newWsRes.status).toBe(201)
      const newWs = await newWsRes.json() as { id: string; name: string }
      expect(newWs.id).toBeTruthy()
      expect(newWs.id).not.toBe(existingWorkspaceId)
      newWorkspaceId = newWs.id

      // Create runtime in new workspace for studio
      const now = new Date().toISOString()
      const rtId = `rt_e2e_new_${Date.now()}`
      sqlRun(
        `INSERT INTO agent_runtime (id, workspace_id, daemon_id, runtime_mode, provider, status, device_info, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rtId, newWorkspaceId, "NewPC.local", "local", "claude", "online", "new-device", now, now,
      )

      // Create studio in new workspace
      const studioRes = await tokenRequest(
        `/api/studios?workspace_id=${newWorkspaceId}`,
        machineToken,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Fresh Start",
            members: [
              {
                role: "leader",
                runtime_id: rtId,
                instructions: "You are the new leader",
              },
            ],
          }),
        },
      )
      expect(studioRes.status).toBe(201)
      const studioData = await studioRes.json() as { agents: Array<{ id: string }> }
      expect(studioData.agents.length).toBe(1)
    })

    afterAll(() => {
      try {
        // Clean new workspace
        if (newWorkspaceId) {
          sqlRun(`DELETE FROM agent_link WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = ?)`, newWorkspaceId)
          sqlRun(`DELETE FROM agent WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM machine WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM member WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM workspace WHERE id = ?`, newWorkspaceId)
        }
        // Clean existing workspace
        sqlRun(`DELETE FROM agent_link WHERE workspace_id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM agent_whitelist WHERE agent_id IN (SELECT id FROM agent WHERE workspace_id = ?)`, existingWorkspaceId)
        sqlRun(`DELETE FROM agent WHERE workspace_id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM machine WHERE workspace_id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM machine_token WHERE id = ?`, machineTokenId)
        sqlRun(`DELETE FROM member WHERE workspace_id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM workspace WHERE id = ?`, existingWorkspaceId)
        sqlRun(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "user" WHERE email = ?`, email)
      } catch { /* ignore cleanup errors */ }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3: Existing user, same computer (config already exists)
  // login → checkExistingAuth valid → "Already logged in"
  // workspace init → resolveClientOpts gets workspace_id → normal logic works
  // ─────────────────────────────────────────────────────────────────────────
  describe("Scenario 3: Existing user, same computer (already configured)", () => {
    const email = `e2e_onboard_same_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let accessToken: string
    let workspaceId: string
    let machineToken: string
    let machineTokenId: string

    beforeAll(async () => {
      await signUp(email, password, "E2E Same PC User")
      sessionCookie = await signIn(email, password)

      // Setup: workspace + machine token already exist and are active
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Same PC Co", slug: `same-pc-co-${randomUUID().slice(0, 8)}` }),
      })
      const wsData = await wsRes.json() as { id: string }
      workspaceId = wsData.id

      // Simulate first-time login + activation
      accessToken = await deviceCodeLogin(sessionCookie)
      const mtRes = await tokenRequest(
        `/api/machine-tokens?workspace_id=${workspaceId}`,
        accessToken,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      )
      const mtData = await mtRes.json() as { token: string; id: string }
      machineToken = mtData.token
      machineTokenId = mtData.id

      await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: machineToken,
          hostname: "SamePC.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })

      // Bind to workspace
      await tokenRequest("/api/machine-tokens/bind-workspace", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
    })

    it("checkExistingAuth: session token still valid → workspaces return data", async () => {
      // Simulates what checkExistingAuth does: verify auth is still valid
      const wsRes = await tokenRequest("/api/workspaces", accessToken)
      expect(wsRes.status).toBe(200)
      const workspaces = await wsRes.json() as Array<{ id: string }>
      expect(workspaces.length).toBeGreaterThanOrEqual(1)
      expect(workspaces.some(w => w.id === workspaceId)).toBe(true)
    })

    it("workspace init: resolveClientOpts gets workspace_id → existing logic works (no regression)", async () => {
      // Machine token is already active and bound to workspace
      const statusRes = await tokenRequest("/api/machine-tokens/status", machineToken)
      expect(statusRes.status).toBe(200)
      const statusData = await statusRes.json() as { status: string; workspace_id: string }
      expect(statusData.status).toBe("active")
      expect(statusData.workspace_id).toBe(workspaceId)

      // Daemon register with workspace works normally
      const regRes = await tokenRequest("/api/daemon/register", machineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          daemon_id: "SamePC.local",
          device_name: "SamePC.local",
          cli_version: "1.0.0",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
      expect(regRes.status).toBe(200)
      const regData = await regRes.json() as { standby?: boolean; runtimes: Array<{ id: string }> }
      expect(regData.standby).toBeFalsy()
      expect(regData.runtimes.length).toBeGreaterThanOrEqual(1)
    })

    afterAll(() => {
      try {
        sqlRun(`DELETE FROM agent_runtime WHERE daemon_id = 'SamePC.local' AND workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM machine WHERE daemon_id = 'SamePC.local' AND workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM machine_token WHERE id = ?`, machineTokenId)
        sqlRun(`DELETE FROM member WHERE workspace_id = ?`, workspaceId)
        sqlRun(`DELETE FROM workspace WHERE id = ?`, workspaceId)
        sqlRun(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "user" WHERE email = ?`, email)
      } catch { /* ignore cleanup errors */ }
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 4: Workspace deleted on server
  // Local config has workspace A → login syncs → server deleted A →
  // workspace init → skip deleted workspace → creates new one
  // ─────────────────────────────────────────────────────────────────────────
  describe("Scenario 4: Workspace deleted on server", () => {
    const email = `e2e_onboard_del_${randomUUID().slice(0, 8)}@test.local`
    const password = "TestPass123!"
    let sessionCookie: string
    let accessToken: string
    let deletedWorkspaceId: string
    let newWorkspaceId: string
    let machineToken: string
    let machineTokenId: string

    beforeAll(async () => {
      await signUp(email, password, "E2E Deleted WS User")
      sessionCookie = await signIn(email, password)

      // Create workspace that will be "deleted"
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Doomed Co", slug: `doomed-co-${randomUUID().slice(0, 8)}` }),
      })
      const wsData = await wsRes.json() as { id: string }
      deletedWorkspaceId = wsData.id

      // Create and activate machine token for this workspace
      accessToken = await deviceCodeLogin(sessionCookie)
      const mtRes = await tokenRequest(
        `/api/machine-tokens?workspace_id=${deletedWorkspaceId}`,
        accessToken,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      )
      const mtData = await mtRes.json() as { token: string; id: string }
      machineToken = mtData.token
      machineTokenId = mtData.id

      await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: machineToken,
          hostname: "DelWS.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })
    })

    it("after workspace deletion, workspace list no longer includes it", async () => {
      // Delete the workspace (simulates server-side deletion)
      sqlRun(`DELETE FROM member WHERE workspace_id = ?`, deletedWorkspaceId)
      sqlRun(`DELETE FROM workspace WHERE id = ?`, deletedWorkspaceId)

      // Login sync: server no longer returns deleted workspace
      const wsRes = await sessionRequest("/api/workspaces", sessionCookie)
      expect(wsRes.status).toBe(200)
      const workspaces = await wsRes.json() as Array<{ id: string }>
      expect(workspaces.every(w => w.id !== deletedWorkspaceId)).toBe(true)
    })

    it("workspace init skips deleted workspace and creates new one", async () => {
      // User sees no workspaces → creates new one
      const newWsRes = await sessionRequest("/api/workspaces", sessionCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Phoenix Co", slug: `phoenix-co-${randomUUID().slice(0, 8)}` }),
      })
      expect(newWsRes.status).toBe(201)
      const newWs = await newWsRes.json() as { id: string; name: string }
      expect(newWs.id).toBeTruthy()
      expect(newWs.id).not.toBe(deletedWorkspaceId)
      newWorkspaceId = newWs.id

      // Create a new machine token for the new workspace
      const mtRes = await tokenRequest(
        `/api/machine-tokens?workspace_id=${newWorkspaceId}`,
        accessToken,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      )
      expect(mtRes.status).toBeLessThan(300)
      const mtData = await mtRes.json() as { token: string; id: string }
      const newMachineToken = mtData.token

      // Activate new token
      await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: newMachineToken,
          hostname: "DelWS.local",
          runtimes: [{ type: "claude", version: "4.0" }],
        }),
      })

      // Bind to new workspace
      const bindRes = await tokenRequest("/api/machine-tokens/bind-workspace", newMachineToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: newWorkspaceId }),
      })
      expect(bindRes.status).toBe(200)
      const bindData = await bindRes.json() as { workspace_id: string; runtimes: Array<{ id: string }> }
      expect(bindData.workspace_id).toBe(newWorkspaceId)
      expect(bindData.runtimes.length).toBeGreaterThanOrEqual(1)

      // Verify new workspace is usable
      const statusRes = await tokenRequest("/api/machine-tokens/status", newMachineToken)
      expect(statusRes.status).toBe(200)
      const statusData = await statusRes.json() as { status: string; workspace_id: string }
      expect(statusData.status).toBe("active")
      expect(statusData.workspace_id).toBe(newWorkspaceId)

      // Clean up the extra machine token
      sqlRun(`DELETE FROM machine_token WHERE id = ?`, mtData.id)
    })

    afterAll(() => {
      try {
        if (newWorkspaceId) {
          sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM machine WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM member WHERE workspace_id = ?`, newWorkspaceId)
          sqlRun(`DELETE FROM workspace WHERE id = ?`, newWorkspaceId)
        }
        sqlRun(`DELETE FROM machine_token WHERE id = ?`, machineTokenId)
        sqlRun(`DELETE FROM "deviceCode" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "session" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "account" WHERE "userId" IN (SELECT id FROM "user" WHERE email = ?)`, email)
        sqlRun(`DELETE FROM "user" WHERE email = ?`, email)
      } catch { /* ignore cleanup errors */ }
    })
  })
})
