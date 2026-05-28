import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "crypto"
import { seedTestData, cleanupTestData, type TestSeed, sessionRequest, tokenRequest, sqlRun, sqlQuery, fetchWithRetry } from "@alook/test-utils"

let seed: TestSeed

beforeAll(() => {
  seed = seedTestData()
})
afterAll(() => cleanupTestData(seed))

describe("machine tokens", () => {
  it("GET /api/machine-tokens lists tokens (requires workspace header)", async () => {
    const res = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
    )
    expect(res.status).toBe(200)
    const data = await res.json() as Array<Record<string, unknown>>
    expect(Array.isArray(data)).toBe(true)
    expect(data.some(t => t.id === seed.machineTokenId)).toBe(true)
  })

  it("POST /api/machine-tokens creates a new token", async () => {
    const res = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "e2e-created" }),
      },
    )
    expect(res.status).toBe(201)
    const data = await res.json() as Record<string, unknown>
    expect(data.token).toBeTruthy()
    expect((data.token as string).startsWith("al_")).toBe(true)
    expect(data.name).toBe("e2e-created")

    // Verify the new token works for auth
    const meRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      data.token as string,
    )
    expect(meRes.status).toBe(200)

    // Cleanup: delete the created token
    const deleteRes = await tokenRequest(
      `/api/machine-tokens/${data.id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(204)
  })

  it("DELETE /api/machine-tokens/:id removes token", async () => {
    // Create a token to delete
    const createRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "to-delete" }),
      },
    )
    const { id, token: newRawToken } = await createRes.json() as { id: string; token: string }

    const deleteRes = await tokenRequest(
      `/api/machine-tokens/${id}?workspace_id=${seed.workspaceId}`,
      seed.machineToken,
      { method: "DELETE" },
    )
    expect(deleteRes.status).toBe(204)

    // Verify deleted token no longer works
    const verifyRes = await tokenRequest(
      `/api/machine-tokens?workspace_id=${seed.workspaceId}`,
      newRawToken,
    )
    expect(verifyRes.status).toBe(401)
  })
})

describe("machine token activation", () => {
  const createdWorkspaceIds: string[] = []

  afterAll(() => {
    for (const wsId of createdWorkspaceIds) {
      try {
        sqlRun(`DELETE FROM agent_runtime WHERE workspace_id = ?`, wsId)
        sqlRun(`DELETE FROM machine WHERE workspace_id = ?`, wsId)
        sqlRun(`DELETE FROM machine_token WHERE workspace_id = ?`, wsId)
        sqlRun(`DELETE FROM member WHERE workspace_id = ?`, wsId)
        sqlRun(`DELETE FROM workspace WHERE id = ?`, wsId)
      } catch { /* ignore */ }
    }
  })

  it("activation without workspace_id creates a new workspace (never reuses)", async () => {
    // Create a pending token WITHOUT workspace_id
    const tokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
    const rawToken = `al_${randomUUID().replace(/-/g, "")}`
    const now = new Date().toISOString()
    sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)`, tokenId, seed.userId, rawToken, 'no-ws-token', 'pending', now)

    // Activate
    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        hostname: "e2e-no-ws-machine",
        runtimes: [{ type: "claude", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { workspace_id: string; daemon_id: string; runtimes: unknown[] }

    // workspace_id should be NEW (not the seed workspace)
    expect(data.workspace_id).toBeTruthy()
    expect(data.workspace_id).not.toBe(seed.workspaceId)
    createdWorkspaceIds.push(data.workspace_id)

    // Verify workspace exists in DB and user is owner
    const wsRows = sqlQuery<{ id: string; name: string }>(
      `SELECT id, name FROM workspace WHERE id = ?`, data.workspace_id
    )
    expect(wsRows).toHaveLength(1)
    expect(wsRows[0]!.name).toBe("Personal")

    const memberRows = sqlQuery<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM member WHERE workspace_id = ? AND user_id = ?`, data.workspace_id, seed.userId
    )
    expect(memberRows).toHaveLength(1)
    expect(memberRows[0]!.role).toBe("owner")
  })

  it("activation with workspace_id uses that workspace (does not create new)", async () => {
    // Create a pending token WITH workspace_id
    const tokenId = `mt_${randomUUID().replace(/-/g, "").slice(0, 21)}`
    const rawToken = `al_${randomUUID().replace(/-/g, "")}`
    const now = new Date().toISOString()
    sqlRun(`INSERT INTO machine_token (id, user_id, workspace_id, token, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, tokenId, seed.userId, seed.workspaceId, rawToken, 'with-ws-token', 'pending', now)

    // Count workspaces before
    const beforeRows = sqlQuery<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM workspace WHERE id IN (SELECT workspace_id FROM member WHERE user_id = ?)`, seed.userId
    )
    const countBefore = beforeRows[0]!.cnt

    // Activate
    const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
    const res = await fetchWithRetry(`${APP_URL}/api/machine-tokens/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: rawToken,
        hostname: "e2e-with-ws-machine",
        runtimes: [{ type: "claude", version: "4.0" }],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as { workspace_id: string }

    // Should use the specified workspace
    expect(data.workspace_id).toBe(seed.workspaceId)

    // No new workspace should be created
    const afterRows = sqlQuery<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM workspace WHERE id IN (SELECT workspace_id FROM member WHERE user_id = ?)`, seed.userId
    )
    expect(afterRows[0]!.cnt).toBe(countBefore)
  })
})
